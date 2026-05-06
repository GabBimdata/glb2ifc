# plan_detector

Service FastAPI qui détecte les murs sur un plan image avec OpenCV, puis le serveur Node peut convertir cette détection en GLB éditable dans le modeler Smelt.

## Lancer

```bash
cd plan_detector
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8765 --reload
```

Le serveur Node (`server.js`) appelle ce service sur `http://127.0.0.1:8765` et l'auto-démarre au premier appel de `/plan2glb`.

## Endpoints Python

- `GET /health` → ping.
- `POST /detect` multipart :
  - `image` : fichier PNG/JPG
  - `scale_mm_per_px` : échelle réelle, en mm/pixel
  - `min_wall_length_mm` : optionnel, défaut `400`
  - `min_wall_thickness_mm` : optionnel, défaut `80`
  - `max_wall_thickness_mm` : optionnel, défaut `900`

Réponse :

```json
{
  "image_size_px": {"w": 1200, "h": 800},
  "scale_mm_per_px": 10.0,
  "walls": [
    {"x1_mm": 0, "y1_mm": 0, "x2_mm": 5000, "y2_mm": 0, "thickness_mm": 200}
  ]
}
```

Coordonnées en repère **bas-gauche** (Y inversé par rapport à l'image), unité **mm**.

## Endpoints Node utiles

Le routeur `src/plan2glb_route.js` ajoute :

- `POST /api/plan-detect` : renvoie le JSON de détection pour debug.
- `POST /plan2glb` : renvoie directement un fichier `.glb` téléchargeable.

Exemple curl :

```bash
curl -X POST http://127.0.0.1:3737/plan2glb \
  -F "image=@plan.jpg" \
  -F "scale_mm_per_px=18.9" \
  -F "wall_height_m=2.7" \
  -F "min_wall_length_mm=400" \
  -F "min_wall_thickness_mm=80" \
  -F "max_wall_thickness_mm=900" \
  -F "filename=plan_detected_walls.glb" \
  -o plan_detected_walls.glb
```

## Compatibilité modeler

Depuis la v5, le GLB généré par `/plan2glb` ne contient plus seulement des boîtes nommées `wall_0`. Chaque mur est nommé `Wall_001`, `Wall_002`, etc. et reçoit des `extras` glTF :

```json
{
  "smeltSource": "plan_detector",
  "smeltIfcType": "IFCWALL",
  "authoringType": "wall",
  "authoringKind": "wall",
  "smeltOpeningHost": true,
  "openingHost": true,
  "canHostOpenings": true,
  "type": "wall",
  "kind": "wall",
  "authoringElementType": "wall",
  "wallHeight": 2.7,
  "wallThickness": 0.2,
  "baseline": {"x1": 0, "y1": 0, "x2": 5, "y2": 0}
}
```

Ces métadonnées sont conservées par `GLTFLoader` dans `mesh.userData` et par `GLTFExporter` lors d'un export depuis le modeler. Elles permettent au modeler et au convertisseur IFC de traiter les murs détectés comme des murs BIM éditables / hôtes d'ouvertures.

## Pipeline détection

1. segmentation couleur HSV des pixels structurels probables : noir, gris CAD/Revit, orange/ocre, hachures ;
2. rejet des annotations colorées et petits composants ;
3. extraction de bandes horizontales/verticales ;
4. fusion/snap des segments colinéaires ;
5. fallback Hough seulement si la vectorisation par bandes ne trouve presque rien.

La détection est volontairement conservatrice : elle donne des primitives BIM candidates qui restent éditables dans le modeler.


## Correctif modeler pour les murs importés

Si le GLB généré s'affiche mais que les outils Door/Window ne snapent pas dessus,
lance aussi le patch :

```bash
node scripts/apply-modeler-plan-wall-compat.mjs
```

Le patch ajoute un petit bloc à la fin de `src/modeler.js`. Il promeut les murs
importés depuis `plan_detector` en murs auteur runtime : `isAuthoringWall`,
`canHostOpenings`, `authoring.type=wall`, centerline XZ, etc. Il est idempotent.
