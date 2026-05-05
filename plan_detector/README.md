# plan_detector

Petit service FastAPI qui détecte les murs sur un plan image (CV classique, OpenCV).

## Lancer

```bash
cd plan_detector
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8765 --reload
```

Le serveur Node (`server.js`) appelle ce service sur `http://127.0.0.1:8765`.

## Endpoints

- `GET  /health` → ping.
- `POST /detect` (multipart) :
  - `image`             : fichier PNG/JPG
  - `scale_mm_per_px`   : échelle (ex: `10` si 1px = 10mm)
  - `min_wall_length_mm`: optionnel, défaut 200mm

Réponse :

```json
{
  "image_size_px": {"w": 1200, "h": 800},
  "scale_mm_per_px": 10.0,
  "walls": [
    {"x1_mm": 0, "y1_mm": 0, "x2_mm": 5000, "y2_mm": 0, "thickness_mm": 200},
    ...
  ]
}
```

Coordonnées en repère **bas-gauche** (Y inversé par rapport à l'image), unité **mm**.

## Pipeline

1. binarisation Otsu inversé (murs en blanc)
2. nettoyage morpho (close + open)
3. squelette (Zhang-Suen)
4. Hough probabiliste → segments
5. fusion colinéaires
6. estimation épaisseur via distance transform
