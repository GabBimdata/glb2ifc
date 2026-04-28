# glb2ifc

<img width="6304" height="1682" alt="Group 3" src="https://github.com/user-attachments/assets/18a93d21-28cc-4147-b48f-63b0bfbdc0e5" />


A small local web app to convert **glTF binary (GLB)** files to **IFC4** with heuristic classification of meshes into walls, slabs, and generic building elements.

> Drag a `.glb` into your browser, get an `.ifc` back. Runs entirely on your machine — no cloud, no upload to any server.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)
![IFC](https://img.shields.io/badge/IFC-4-orange.svg)

## Why?

GLB is a great format for visualization, but it's purely geometric — it has no notion of "this is a wall" or "this is a floor slab". IFC, the BIM standard, does. Most existing GLB → IFC converters wrap everything in `IfcBuildingElementProxy` (a generic "thing"), which produces a valid file but loses any meaningful BIM semantics.

This tool tries to do slightly better by classifying meshes based on their bounding box geometry:

- **Flat & wide** (vertical span < 0.5m, horizontal span > 1m) → `IfcSlab`
- **Tall & thin** (vertical span > 1m, one horizontal axis < 0.6m) → `IfcWall`
- **Everything else** → `IfcBuildingElementProxy`

It works reasonably well on architectural exports where buildings have clean wall/slab geometry. Less so on furniture-heavy or organic models.

## Quick start

You need [Node.js 18+](https://nodejs.org) or [Bun](https://bun.sh).

```bash
git clone https://github.com/GabBimdata/glb2ifc.git
cd glb2ifc
npm install        # or: bun install
npm start          # or: bun run start
```

Then open <http://localhost:3737> in your browser and drop a GLB file.

## How it works

```
GLB file
   ↓
@gltf-transform/core parses meshes + applies world transforms
   ↓
For each mesh:
   • compute bounding box
   • analyze triangle orientation / vertical faces
   • extract material color, material name and opacity
   ↓
First pass classification:
   • slabs / floors
   • walls and exterior wall candidates
   • doors and windows
   • beams
   • roofs
   • generic proxies
   ↓
Refinement passes:
   • detect storeys from slab elevations and wall bases
   • assign elements to the nearest building storey
   • detect exterior walls from the building envelope
   • refine openings by checking overlap with host walls
   ↓
Generate IFC4 STEP-21 text file with:
   • Project → Site → Building → Storey(s) hierarchy
   • IfcWall, IfcSlab, IfcDoor, IfcWindow, IfcBeam, IfcRoof
   • IfcBuildingElementProxy for unclassified geometry
   • IfcTriangulatedFaceSet geometry, preserving original triangles
   • IfcSurfaceStyle per unique color
   • Pset_WallCommon, Pset_BeamCommon and Pset_RoofCommon
   • automatic element names such as Wall 001, Slab 001, Beam 001
   • Y-up (glTF) → Z-up (IFC) axis conversion
   • proper STEP-21 string escaping
   ↓
IFC file downloaded
```

The IFC writer is a hand-rolled STEP-21 generator (no `web-ifc` or `IfcOpenShell` dependency on the server). The output passes validation in `IfcOpenShell`, BlenderBIM/Bonsai, and FreeCAD.

## Limits & caveats

- **Units**: assumes the GLB is in **meters**. If your file is in millimeters or centimeters, the IFC will be wrong by a factor of 1000 or 100.
- **Heuristic classification**: the converter uses bounding boxes, triangle orientation, material hints, mesh names, opacity, and spatial relationships. It is a best-effort semantic reconstruction, not a substitute for real BIM authoring.
- **Storey detection is approximate**: storeys are detected from slab elevations and wall bases. Models without clear floors, with split slabs, mezzanines, ramps, or unusual vertical offsets may produce imperfect storey assignments.
- **Exterior wall detection is approximate**: `Pset_WallCommon.IsExternal` is inferred from the wall position near the building envelope and from façade-like geometry. Complex buildings, courtyards, patios, L/U-shaped plans, merged façade meshes, or interior atriums may need manual checking.
- **Openings are detected only when represented as geometry**: doors and windows can be classified when they are separate mesh elements or glass-like/opening-like elements overlapping a wall. The converter does not cut actual voids into walls and does not create `IfcOpeningElement`.
- **Beams and roofs are heuristic**: long horizontal elements may be classified as `IfcBeam`, and high/inclined or roof-named elements may be classified as `IfcRoof`. Furniture, decorative trims, soffits, parapets, or ceiling elements can still be misclassified.
- **Materials are limited**: base color is preserved as `IfcSurfaceStyle`. Textures, normal maps, metallic/roughness, transparency rendering, and full glTF material properties are not fully exported.
- **Property sets are minimal**: the converter writes basic common property sets such as `Pset_WallCommon`, `Pset_BeamCommon`, and `Pset_RoofCommon`, but values are inferred or left blank when the GLB does not contain reliable BIM data.
- **Geometry is tessellated**: elements are exported using `IfcTriangulatedFaceSet`, preserving the original triangles. They are not converted into parametric BIM solids or clean extrusion profiles.
- **Non-ASCII characters in original mesh names are replaced with `_`**: proper STEP-21 Unicode escaping is still a future improvement. Generated IFC element names such as `Wall 001` and `Slab 001` avoid most naming issues.

## Validating the output

Open the resulting `.ifc` file in any of:

- **[BIMData.io](https://bimdata.io/)** — Europe’s sovereign alternative: an open-core ecosystem for IFC integrity and data independence
- **[Bonsai (BlenderBIM)](https://bonsaibim.org/)** — open source, the most rigorous IFC viewer/editor
- **[FreeCAD](https://www.freecad.org/)** with the BIM workbench
- **[IfcOpenShell](https://ifcopenshell.org/)** for CLI validation: `ifctester` or `IfcConvert model.ifc model.glb` (round trip)
- Any commercial IFC viewer (Solibri, Tekla BIMsight, etc.)

## Stack

- **Server**: Node.js + Express + Multer
- **GLB parsing**: [@gltf-transform/core](https://github.com/donmccurdy/glTF-Transform) with all extensions registered (handles `KHR_texture_transform` etc. without complaining)
- **IFC writing**: hand-rolled STEP-21 generator (no external IFC library — kept the dependency footprint minimal)
- **Frontend**: vanilla HTML/CSS/JS, no framework

## Contributing

PRs welcome! Particularly interesting directions:

- [ ] Multi-storey detection (group meshes by Y altitude bands)
- [ ] Door/window heuristics (small rectangular elements within walls)
- [ ] Property set generation from glTF materials/extras
- [ ] Proper Unicode escaping (`\X2\xxxx\X0\` for non-ASCII chars)
- [ ] Configurable mapping (let users tune classification thresholds)
- [ ] Direct GLB → IFC streaming for large files (current implementation loads everything in memory)

## License

[MIT](LICENSE)
