# glb2ifc — patch modeler V2

## Workflow recommandé

1. Ouvre `http://localhost:3737/`.
2. Dépose un `.glb`.
3. Le convertisseur télécharge l'IFC et crée aussi un projet local dans IndexedDB.
4. Clique sur `Ouvrir dans le viewer avec GLB lié →`.
5. Dans le viewer IFC, fais tes reclassifications si besoin.
6. Clique sur `Modéliser GLB`.
7. Le modeler ouvre automatiquement le GLB source lié au viewer.
8. Sélectionne un mesh, utilise le gizmo Three.js :
   - `T` translate
   - `R` rotate
   - `S` scale
   - `L` local
   - `W` world
9. Clique sur `Enregistrer → retour viewer IFC`.
10. Le modeler exporte un GLB baked, reconvertit en IFC, réapplique les reclassifications en attente, puis rouvre le viewer.

## Notes importantes

- Le lien GLB ↔ IFC est stocké localement dans le navigateur avec IndexedDB.
- Si tu ouvres un IFC téléchargé manuellement, le viewer essaie de retrouver le GLB source via le nom de fichier.
- Les reclassifications sont réappliquées par `localId`. Tant que le convertisseur garde le même ordre de meshes, le mapping reste stable.
- Le bug du gizmo invisible a été corrigé : avec Three.js récent, `TransformControls` doit être ajouté à la scène via `transform.getHelper()`.

## Fichiers ajoutés / modifiés

- `src/project-store.js` : stockage local du projet GLB/IFC/edits.
- `public/index.html` : crée un projet local après conversion et ajoute un lien viewer lié.
- `public/viewer.html` : ajoute le bouton `Modéliser GLB`.
- `src/viewer.js` : sauvegarde les reclassifications et ouvre le modeler avec le GLB source.
- `src/modeler.js` : charge le GLB depuis le projet, corrige le gizmo, reconvertit et retourne au viewer.
- `server.js` : sert `/modeler.html` et les décodeurs Draco locaux.
