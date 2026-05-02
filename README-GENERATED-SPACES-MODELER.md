# Generated IFC spaces in the GLB modeler

V12 fixes an important workflow gap: spaces generated during `GLB → IFC` conversion are not present in the source GLB, so the Three.js GLB modeler could not show or edit them.

## What changed

When the modeler is opened from the IFC viewer with a linked project:

1. The modeler still opens the source GLB.
2. It also reads the current IFC text stored in IndexedDB.
3. It extracts `IFCSPACE` tessellated geometry from the IFC.
4. It adds those generated spaces as translucent editable meshes in the Three.js scene.
5. At export, those meshes are written into the baked GLB with `smeltIfcType = IFCSPACE` metadata.
6. On reconversion, the backend recognises those meshes and exports them back as `IfcSpace` instead of proxies.

## Important notes

- `IfcZone` is a grouping object in this converter and normally has no geometry. The visible/editable volumes are `IfcSpace` elements.
- If editable/generated spaces are present in the GLB, the converter does not generate a second automatic set of spaces. It treats the edited spaces as the source of truth for spaces.
- Reclassifications made in the IFC viewer are still reapplied after the modeler round-trip.

## Workflow

1. Upload GLB.
2. Open IFC in the viewer.
3. Click **Modéliser GLB**.
4. The modeler opens the source GLB + generated IFC spaces as editable translucent blue meshes.
5. Move/scale/rotate the spaces with the gizmo.
6. Click **Enregistrer → retour viewer IFC**.

The returned IFC should now contain the edited `IfcSpace` volumes.

## Duplicate protection

If the project GLB already contains editable `IFCSPACE` meshes from a previous modeler round-trip, the modeler does **not** import a second copy from the IFC text.
