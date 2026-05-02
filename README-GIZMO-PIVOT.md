# V11 — correction du pivot / gizmo du modeler GLB

## Problème corrigé

Certains GLB exportés depuis 3ds Max, SketchUp, Revit, etc. ont des meshes dont les vertices sont très loin de l'origine locale du node. Three.js `TransformControls` s'attache à `object.position`, donc le gizmo se retrouve loin de la géométrie visible.

## Correction

Au chargement du GLB, le modeler recentre automatiquement le pivot éditable des meshes classiques au centre de leur bounding box locale :

1. calcule la bbox de la géométrie locale ;
2. translate les vertices pour placer le centre de bbox à l'origine locale ;
3. compense la transform locale du mesh pour que la géométrie ne bouge pas visuellement ;
4. stocke ce nouvel état comme transform de reset.

Résultat : le gizmo translate / rotate / scale apparaît au centre de la géométrie sélectionnée, et l'export GLB baked reste compatible avec le pipeline GLB → IFC.

## Note

Les `InstancedMesh` ne sont pas recentrés automatiquement dans cette V11. Ils restent exportés en meshes baked au moment de l'export, comme avant.
