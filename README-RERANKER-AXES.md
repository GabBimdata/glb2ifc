# Reranker axes fix (V9)

The GLB pipeline is **Y-up** while the generated IFC geometry is written as **Z-up**:

```txt
GLB position: (x, y, z)
IFC point:    (x, -z, y)
```

The Qwen reranker reads the geometry back from the IFC. Before V9, the feature extractor accidentally treated IFC `Y` as the vertical axis. That could make vertical objects look like horizontal slabs in the reranker prompt.

V9 normalizes IFC bounds back to the internal classifier convention before scoring:

```txt
feature.sizeX = IFC X      # plan axis
feature.sizeY = IFC Z      # vertical axis
feature.sizeZ = IFC Y      # plan axis
```

The face normal ratios were also fixed: horizontal faces are now detected with `abs(normal.z)` from the IFC triangles, not `abs(normal.y)`.

You can inspect what is sent to the UI in `/api/qwen-suggest` responses under `features.bbox`:

```json
{
  "coordinateSystem": "IFC_Z_UP_NORMALIZED_TO_Y_UP",
  "verticalAxisInSource": "Z",
  "sizeY": 2.70,
  "verticalSize": 2.70
}
```
