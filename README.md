# glb2ifc

<img width="6304" height="1682" alt="Group 3" src="https://github.com/user-attachments/assets/0faa42d7-5a68-42fe-96f1-d5ba5b1a242c" />


A small local web app to convert **glTF binary (GLB)** files to **IFC4** with heuristic classification of architectural elements.

> Drag a `.glb` into your browser, get an `.ifc` back. Runs locally on your machine — no cloud upload.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)
![IFC](https://img.shields.io/badge/IFC-4-orange.svg)

## What it detects

The converter tries to infer BIM semantics from raw GLB geometry.

It currently detects and exports:

- `IfcWall`
- exterior walls with `Pset_WallCommon.IsExternal`
- `IfcSlab`
- `IfcDoor`
- `IfcWindow`
- `IfcBeam`
- `IfcColumn`
- `IfcStair`
- `IfcRoof`
- `IfcBuildingElementProxy` for unclassified geometry

It also adds:

- automatic storey detection
- automatic element naming, such as `Wall 001`, `Slab 001`, `Beam 001`
- base color preservation through `IfcSurfaceStyle`
- basic IFC property sets
- Uniformat II classification references

## Why?

GLB is great for visualization, but it usually has no BIM semantics. A mesh does not inherently know whether it is a wall, slab, beam, roof, stair, or window.

Most simple GLB → IFC conversions wrap everything as `IfcBuildingElementProxy`, which creates a valid IFC file but loses most of the useful building information.

This tool tries to do better by using:

- bounding boxes
- triangle orientation
- vertical and horizontal face ratios
- material names
- mesh names
- material opacity
- spatial relationships
- wall overlap
- building envelope detection
- storey context
- top-of-building context

The result is still heuristic, but it gives a much richer IFC starting point.

## Quick start

You need [Node.js 18+](https://nodejs.org) or Bun.

```bash
git clone https://github.com/YOUR_USERNAME/glb2ifc.git
cd glb2ifc
npm install
npm start
```

Then open:

```txt
http://localhost:3737
```

Drop a `.glb` file into the browser and download the generated `.ifc`.

## How it works

```txt
GLB file
   ↓
@gltf-transform/core parses meshes + applies world transforms
   ↓
For each mesh:
   • compute bounding box
   • analyze triangle orientation
   • detect vertical, horizontal and inclined face ratios
   • extract material color, material name and opacity
   ↓
First pass classification:
   • slabs / floors
   • walls and facade-like vertical elements
   • beams
   • columns
   • stairs
   • roofs
   • generic proxies
   ↓
Storey detection v2:
   • collect candidate levels from slab tops
   • collect wall, door, column and stair bases
   • cluster elevations
   • score candidate levels
   • ignore weak/ceiling-like levels
   • assign elements to storeys with upward snapping for thick/old buildings
   ↓
Refinement passes:
   • detect doors and windows from wall overlap and floor offset
   • detect exterior walls from envelope position and facade-like geometry
   • promote high/inclined roof-like elements to roofs
   • classify roof beams separately from floor beams
   ↓
Generate IFC4 STEP-21 text file with:
   • Project → Site → Building → Storey(s) hierarchy
   • IfcWall, IfcSlab, IfcDoor, IfcWindow
   • IfcBeam, IfcColumn, IfcStair, IfcRoof
   • IfcBuildingElementProxy for unclassified geometry
   • IfcTriangulatedFaceSet geometry preserving original triangles
   • IfcSurfaceStyle per unique base color
   • Pset_WallCommon
   • Pset_BeamCommon
   • Pset_ColumnCommon
   • Pset_StairCommon
   • Pset_RoofCommon
   • Uniformat II classification references
   • automatic element names
   • Y-up glTF → Z-up IFC axis conversion
   • STEP-21 string escaping
   ↓
IFC file downloaded
```

## Classification logic

The converter uses a best-effort heuristic pipeline.

Examples:

- flat and wide elements → `IfcSlab`
- tall thin elements → `IfcWall`
- vertical-face-dominant facade meshes → `IfcWall`
- envelope walls → `IfcWall` with `Pset_WallCommon.IsExternal = true`
- small thin elements overlapping host walls near floor level → `IfcDoor`
- small thin glass-like or elevated elements overlapping host walls → `IfcWindow`
- long horizontal structural elements → `IfcBeam`
- compact vertical structural elements → `IfcColumn`
- named or repeated-step geometry → `IfcStair`
- high, inclined or roof-named elements → `IfcRoof`
- everything else → `IfcBuildingElementProxy`

The classifier supports both English and French mesh/material hints, for example:

```txt
wall, mur, murs, cloison
door, porte, portes
window, fenêtre, fenetre, vitrage, glass
beam, poutre, linteau, chevron, panne
column, colonne, poteau, pilier
stair, escalier, marche, contremarche
roof, toit, toiture, couverture, tuile, charpente
```

## IFC property sets

The converter writes minimal common property sets where relevant.

### Walls

```txt
Pset_WallCommon
  Reference = ""
  IsExternal = true / false
  LoadBearing = false
  ExtendToStructure = false
```

### Beams

```txt
Pset_BeamCommon
  Reference = ""
  IsExternal = false
  LoadBearing = false
```

### Columns

```txt
Pset_ColumnCommon
  Reference = ""
  IsExternal = false
  LoadBearing = false
```

### Stairs

```txt
Pset_StairCommon
  Reference = ""
  IsExternal = false
```

### Roofs

```txt
Pset_RoofCommon
  Reference = ""
  IsExternal = true
  LoadBearing = false
```

These values are intentionally conservative. For example, `LoadBearing` is left as `false` because a GLB file usually does not contain reliable structural intent.

## Uniformat II classification

The converter can attach Uniformat II classifications using:

```txt
IfcClassification
IfcClassificationReference
IfcRelAssociatesClassification
```

Current mapping:

```txt
External wall       → B2010 Exterior Walls
Interior wall       → C1010 Partitions
Slab                → B1010 Floor Construction
Floor beam          → B1010 Floor Construction
Roof beam           → B1020 Roof Construction
Column              → B1010 Floor Construction
Roof                → B3010 Roof Coverings
Exterior window     → B2020 Exterior Windows
Exterior door       → B2030 Exterior Doors
Interior door       → C1020 Interior Doors
Stair               → C2010 Stair Construction
Proxy               → no classification
```

Beams are classified contextually:

```txt
IfcBeam near the roof / roof zone / roof mesh
→ B1020 Roof Construction

IfcBeam elsewhere
→ B1010 Floor Construction
```

## Storey detection

Storeys are detected automatically using a scoring system based on:

- slab top elevations
- wall bases
- door bases
- column bases
- stair bases
- weak hints from windows and beams

The converter clusters vertical levels, scores them, and filters out weak or ceiling-like candidates.

The default minimum storey height is:

```js
const MIN_STOREY_HEIGHT = 2.0;
```

This is tuned to support older buildings with low ceilings, for example around 2.18 m.

If needed, this value can be adjusted in `server.js`.

## Limits & caveats

- **Units**: assumes the GLB is in **meters**. If your file is in millimeters or centimeters, the IFC will be wrong by a factor of 1000 or 100.

- **Heuristic classification**: the converter uses geometry, names, material hints, opacity and spatial relationships. It is a best-effort semantic reconstruction, not a substitute for real BIM authoring.

- **Storey detection is approximate**: it works better than a simple slab-only approach, but mezzanines, split levels, ramps, thick floors, partial levels, merged meshes or unusual old buildings may still need manual review.

- **Exterior wall detection is approximate**: `Pset_WallCommon.IsExternal` is inferred from envelope position, vertical facade-like geometry and naming hints. Courtyards, patios, atriums, L/U-shaped buildings or merged facade meshes can still be difficult.

- **Doors and windows are geometry-based**: they can be detected when represented as separate or glass-like mesh elements overlapping a wall. The converter does not create real wall voids or `IfcOpeningElement` relationships yet.

- **Beams, columns, stairs and roofs are heuristic**: furniture, trims, railings, shelves, facade details, decorative beams, roof ornaments or repeated geometry may still be misclassified.

- **Materials are limited**: base color is preserved as `IfcSurfaceStyle`. Textures, normal maps, metallic/roughness values and full transparency rendering are not fully exported.

- **Property sets are minimal**: common Psets are generated, but values are inferred or left blank when the GLB does not contain reliable BIM data.

- **Uniformat II is inferred**: classification is attached based on detected IFC class and context. It should be reviewed before downstream cost estimating or formal classification workflows.

- **Geometry is tessellated**: elements are exported as `IfcTriangulatedFaceSet`. They are not converted into clean parametric extrusions or native BIM solids.

- **Unicode escaping is incomplete**: non-ASCII characters in source names are replaced with `_`. Generated names such as `Wall 001` avoid most issues, but proper STEP-21 Unicode escaping is still a future improvement.

## Validating the output

Open the generated IFC in any IFC viewer, for example:

- Bonsai / BlenderBIM
- FreeCAD BIM Workbench
- IfcOpenShell tools
- Solibri
- BIMcollab Zoom
- other commercial IFC viewers

Check especially:

- element classes
- storey assignment
- `Pset_WallCommon.IsExternal`
- Uniformat II classification references
- remaining `IfcBuildingElementProxy` elements
- false positives for doors, windows, beams, stairs or roofs

## Stack

- **Server**: Node.js + Express + Multer
- **GLB parsing**: `@gltf-transform/core` with `@gltf-transform/extensions`
- **IFC writing**: hand-written STEP-21 generator
- **Frontend**: vanilla HTML/CSS/JS

## Contributing

PRs welcome! Particularly interesting directions:

- [ ] **Detect more IFC element types**
  - `IfcRailing`
  - `IfcCurtainWall`
  - `IfcCovering`
  - `IfcRamp`
  - `IfcMember`
  - `IfcFooting`
  - `IfcSpace`

- [ ] **Improve interior wall detection**
  - distinguish interior walls from thin facade parts
  - reduce false door/window detection on wall fragments
  - detect host walls before detecting openings
  - support merged or fragmented wall meshes

- [ ] **Improve doors and windows**
  - reduce false positives
  - distinguish windows, curtain wall panels and glass facade systems
  - optionally create `IfcOpeningElement`
  - add host-wall relationships where possible

- [ ] **Improve stairs**
  - distinguish full stairs from individual steps
  - support `IfcStairFlight`
  - detect landings
  - avoid false positives from shelves or stepped facades

- [ ] **Improve material handling**
  - export transparency for glass-like materials
  - map glTF materials to IFC material definitions
  - reuse identical materials
  - support `IfcRelAssociatesMaterial`
  - infer basic construction types from material names

- [ ] **Improve Uniformat classification**
  - refine mappings for interior/exterior systems
  - classify roof structure vs roof covering more accurately
  - add configurable Uniformat mapping
  - support other classification systems later, such as Omniclass or Uniclass

- [ ] **Add IFC type objects**
  - generate `IfcWallType`, `IfcSlabType`, `IfcDoorType`, `IfcWindowType`
  - generate `IfcBeamType`, `IfcColumnType`, `IfcRoofType`, `IfcStairType`
  - group elements by thickness, material, role or classification
  - move common properties to types where appropriate

- [ ] **Add IFC layers and systems**
  - create `IfcPresentationLayerAssignment`
  - group elements by category, material or source hierarchy
  - explore `IfcSystem` where meaningful

- [ ] **Make heuristics configurable**
  - expose thresholds in a config file or UI
  - tune wall thickness, slab thickness, storey height, openings, roof detection and stair detection
  - add presets for architecture, structure, scan-derived models and visualization models

- [ ] **Improve storey and spatial structure**
  - better support mezzanines, split levels and ramps
  - handle tall elements spanning multiple storeys
  - optionally detect spaces/zones from enclosed geometry

- [ ] **Improve geometry output**
  - optional mesh simplification
  - detect extrusions where possible
  - reduce IFC size for heavy GLB files
  - investigate streaming conversion for large files

- [ ] **Improve metadata and encoding**
  - read glTF `extras`
  - preserve original mesh names as optional metadata
  - implement proper STEP-21 Unicode escaping
  - add validation tooling and sample test models

## License

MIT
