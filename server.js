import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { createServer as createViteServer } from 'vite';
import { applyReclassifications, IFC_TYPES, reclassifiableTypeNames } from './src/ifc-patcher.js';
import { IFC_CATEGORIES } from './src/ifc-catalog.js';
import { candidateDocumentForIfcType } from './src/ifc-classification-kb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QWEN_ENV_KEYS = [
  'QWEN_LLAMA_SERVER_BIN',
  'QWEN_MODEL_PATH',
  'QWEN_LLAMA_HOST',
  'QWEN_LLAMA_PORT',
  'QWEN_LLAMA_CONTEXT',
  'QWEN_LLAMA_BATCH',
  'QWEN_AUTO_START',
  'QWEN_RERANKER_URL',
];

function repairQwenEnvNewlines(content) {
  let repaired = String(content || '');
  for (const key of QWEN_ENV_KEYS) {
    repaired = repaired.replace(new RegExp(`([^\r\n])(?=${key}=)`, 'g'), '$1\n');
  }
  return repaired;
}

function parseEnvLines(content) {
  return repairQwenEnvNewlines(content).split(/\r?\n/);
}

function loadLocalEnvFiles() {
  for (const filename of ['.env', '.env.local']) {
    const envPath = path.join(__dirname, filename);
    if (!fs.existsSync(envPath)) continue;

    const lines = parseEnvLines(fs.readFileSync(envPath, 'utf8'));
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;

      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

loadLocalEnvFiles();

const app = express();
const PORT = 3737;

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

let dracoDecoderModulePromise = null;

function getDracoDecoderModule() {
  if (!dracoDecoderModulePromise) {
    dracoDecoderModulePromise = draco3d.createDecoderModule();
  }

  return dracoDecoderModulePromise;
}

async function createGLTFReader() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  // Required for GLBs using KHR_draco_mesh_compression. Without this explicit
  // dependency @gltf-transform can fail with errors such as:
  // "undefined is not an object (evaluating 'decoderModule.DT_FLOAT32')".
  io.registerDependencies({
    'draco3d.decoder': await getDracoDecoderModule()
  });

  return io;
}

['uploads', 'outputs'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});


// Allow large IFC payloads for the /api/reexport endpoint
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// Draco decoder files for the pure Three.js GLB modeler. This keeps Draco-compressed
// GLBs loadable in /modeler.html without requiring a CDN.
app.use('/vendor/draco', express.static(path.join(__dirname, 'node_modules/three/examples/jsm/libs/draco')));

// Vite is used only to serve the BIM viewer module with local npm imports.
// The converter UI and /api/convert remain handled by Express.
const vite = await createViteServer({
  root: __dirname,
  server: { middlewareMode: true },
  appType: 'custom',
  publicDir: false
});
app.use(vite.middlewares);

app.get('/viewer.html', (req, res, next) => {
  const viewerPath = path.join(__dirname, 'public', 'viewer.html');
  if (fs.existsSync(viewerPath)) {
    return res.sendFile(viewerPath);
  }
  next();
});


app.get('/modeler.html', (req, res, next) => {
  const modelerPath = path.join(__dirname, 'public', 'modeler.html');
  if (fs.existsSync(modelerPath)) {
    return res.sendFile(modelerPath);
  }
  next();
});



// ─────────────────────────────────────────────────────────────────────────────
// STEP-21 string escaping
// ─────────────────────────────────────────────────────────────────────────────

function escapeIFCString(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/[^\x20-\x7E]/g, '_');
}

// ─────────────────────────────────────────────────────────────────────────────
// GLB extraction
// ─────────────────────────────────────────────────────────────────────────────

function computeBoundingBox(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = positions[i + j];
      if (v < min[j]) min[j] = v;
      if (v > max[j]) max[j] = v;
    }
  }
  return { min, max };
}

function safeNodeExtras(node) {
  try {
    const extras = node?.getExtras?.();
    return extras && typeof extras === 'object' ? extras : {};
  } catch {
    return {};
  }
}

function manualIfcTypeFromExtras(extras, nodeName = '') {
  const raw = String(extras?.smeltIfcType || extras?.ifcType || extras?.IFCType || '').toUpperCase();
  if (raw === 'IFCSPACE') return 'IFCSPACE';

  if (/^IFCSPACE[_\s#-]/i.test(String(nodeName || ''))) return 'IFCSPACE';
  if (/^Generated IFC Spaces/i.test(String(nodeName || ''))) return '';

  return '';
}

function extractMaterialInfo(primitive) {
  const material = primitive.getMaterial();
  if (!material) {
    return {
      color: null,
      materialName: '',
      opacity: 1,
      hasSourceMaterial: false
    };
  }

  const base = material.getBaseColorFactor() || [1, 1, 1, 1];
  return {
    color: { r: base[0], g: base[1], b: base[2] },
    materialName: material.getName() || '',
    opacity: base[3] ?? 1,
    hasSourceMaterial: true
  };
}

async function extractMeshesFromGLB(glbPath) {
  const io = await createGLTFReader();
  const document = await io.read(glbPath);
  const root = document.getRoot();

  const extracted = [];

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const worldMatrix = node.getWorldMatrix();
    const extras = safeNodeExtras(node);
    const nodeName = node.getName() || mesh.getName() || 'unnamed';
    const manualIfcType = manualIfcTypeFromExtras(extras, nodeName);

    for (const primitive of mesh.listPrimitives()) {
      const positionAttr = primitive.getAttribute('POSITION');
      const indicesAccessor = primitive.getIndices();
      if (!positionAttr) continue;

      const positions = positionAttr.getArray();
      const indices = indicesAccessor ? indicesAccessor.getArray() : null;
      if (!indices || indices.length === 0) continue;

      const transformed = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        transformed[i]     = worldMatrix[0] * x + worldMatrix[4] * y + worldMatrix[8]  * z + worldMatrix[12];
        transformed[i + 1] = worldMatrix[1] * x + worldMatrix[5] * y + worldMatrix[9]  * z + worldMatrix[13];
        transformed[i + 2] = worldMatrix[2] * x + worldMatrix[6] * y + worldMatrix[10] * z + worldMatrix[14];
      }

      const materialInfo = extractMaterialInfo(primitive);

      extracted.push({
        name: nodeName,
        positions: transformed,
        indices: Array.from(indices),
        bbox: computeBoundingBox(transformed),
        manualIfcType,
        smeltSource: extras?.smeltSource || '',
        smeltOriginalLocalId: extras?.smeltOriginalLocalId || null,
        smeltPredefinedType: extras?.smeltPredefinedType || null,
        ...materialInfo
      });
    }
  }

  return extracted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mesh classification
// ─────────────────────────────────────────────────────────────────────────────

function isManualSpaceMesh(mesh) {
  return String(mesh?.manualIfcType || '').toUpperCase() === 'IFCSPACE';
}

const STOREY_LEVEL_TOLERANCE = 0.28;
// Tuned for older buildings: a ground-floor ceiling of ~2.18m should still
// allow the next real level to be detected. Lower to ~1.85 only for very low
// split-level buildings; raise to ~2.30 for modern regular buildings.
const MIN_STOREY_HEIGHT = 2.0;
const STOREY_MIN_SCORE = 3.0;

function bboxStats(mesh) {
  const [minX, minY, minZ] = mesh.bbox.min;
  const [maxX, maxY, maxZ] = mesh.bbox.max;
  const sizeX = maxX - minX;
  const sizeY = maxY - minY; // Y vertical in glTF
  const sizeZ = maxZ - minZ;
  const horizontal = Math.max(sizeX, sizeZ);
  const minHoriz = Math.min(sizeX, sizeZ);
  const areaXZ = Math.max(0, sizeX) * Math.max(0, sizeZ);

  return {
    minX, minY, minZ, maxX, maxY, maxZ,
    sizeX, sizeY, sizeZ,
    horizontal,
    minHoriz,
    areaXZ,
    centerY: (minY + maxY) / 2
  };
}

function globalMeshBounds(meshes) {
  if (!meshes || meshes.length === 0) {
    return null;
  }

  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity]
  };

  for (const mesh of meshes) {
    for (let i = 0; i < 3; i++) {
      bounds.min[i] = Math.min(bounds.min[i], mesh.bbox.min[i]);
      bounds.max[i] = Math.max(bounds.max[i], mesh.bbox.max[i]);
    }
  }

  const size = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ];

  return {
    ...bounds,
    size,
    maxDimension: Math.max(...size),
    verticalDimension: size[1]
  };
}

function inferModelScale(meshes) {
  const bounds = globalMeshBounds(meshes);

  if (!bounds) {
    return {
      scale: 1,
      applied: false,
      assumedInputUnit: 'metre',
      reason: 'no geometry',
      originalMaxDimension: 0,
      normalizedMaxDimension: 0
    };
  }

  const maxDimension = bounds.maxDimension;
  const verticalDimension = bounds.verticalDimension;

  // IFC output is declared in metres. Many GLB files from CAD/BIM/web exports
  // are stored in millimetres even though glTF is unitless. If exported as-is,
  // BIMData / IfcOpenShell will read a 5000mm wall as 5000m.
  //
  // Keep this deliberately conservative:
  // - > 500 units vertical is almost certainly mm for an architectural model.
  // - > 1000 units global extent is also a strong mm signal.
  // - do not guess centimetres automatically; that is too risky for sites.
  const likelyMillimetres =
    verticalDimension > 500 ||
    maxDimension > 1000;

  if (likelyMillimetres) {
    return {
      scale: 0.001,
      applied: true,
      assumedInputUnit: 'millimetre',
      outputUnit: 'metre',
      reason: `large model extent detected (max=${maxDimension.toFixed(2)}, vertical=${verticalDimension.toFixed(2)})`,
      originalMaxDimension: maxDimension,
      normalizedMaxDimension: maxDimension * 0.001
    };
  }

  return {
    scale: 1,
    applied: false,
    assumedInputUnit: 'metre',
    outputUnit: 'metre',
    reason: `model extent already plausible in metres (max=${maxDimension.toFixed(2)}, vertical=${verticalDimension.toFixed(2)})`,
    originalMaxDimension: maxDimension,
    normalizedMaxDimension: maxDimension
  };
}

function applyScaleToMeshes(meshes, scaleInfo) {
  const scale = Number(scaleInfo?.scale || 1);

  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 1e-12) {
    return scaleInfo;
  }

  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i++) {
      mesh.positions[i] *= scale;
    }

    mesh.bbox = computeBoundingBox(mesh.positions);
    mesh.appliedInputScale = scale;
  }

  return {
    ...scaleInfo,
    boundsAfterScale: globalMeshBounds(meshes)
  };
}

function normalizeMeshUnits(meshes) {
  const scaleInfo = inferModelScale(meshes);
  return applyScaleToMeshes(meshes, scaleInfo);
}

function searchableText(mesh) {
  return `${mesh.name || ''} ${mesh.materialName || ''}`.toLowerCase();
}

function hasDoorHint(mesh) {
  return /\b(door|doors|porte|portes|ouvrant|battant)\b/i.test(searchableText(mesh));
}

function hasWindowHint(mesh) {
  return /\b(window|windows|fenetre|fenêtres|fenetre|vitre|vitrage|glass|glazing)\b/i.test(searchableText(mesh));
}

function hasWallHint(mesh) {
  return /\b(wall|walls|mur|murs|cloison|partition)\b/i.test(searchableText(mesh));
}

function hasExteriorWallHint(mesh) {
  return /(exterior|external|outside|facade|façade|facades|façades|exterieur|extérieur|exterieure|extérieure|envelope|enveloppe|bardage|cladding)/i.test(searchableText(mesh));
}

function hasSlabHint(mesh) {
  return /\b(slab|floor|floors|plancher|dalle|ceiling|plafond)\b/i.test(searchableText(mesh));
}

function hasBeamHint(mesh) {
  return /\b(beam|beams|beem|beems|poutre|poutres|joist|joists|girder|girders|lintel|lintels|linteau|linteaux|ipe|hea|heb|ipn)\b/i.test(searchableText(mesh));
}

function hasRoofHint(mesh) {
  return /\b(roof|roofs|roofing|rooftop|toit|toits|toiture|toitures|couverture|couvertures|tuile|tuiles|shingle|shingles)\b/i.test(searchableText(mesh));
}

function hasRoofStructureHint(mesh) {
  // Terms that indicate roof framing / charpente rather than floor framing.
  // Keep accented and non-accented French variants for real-world mesh names.
  return /\b(roof\s*beam|roof\s*joist|roof\s*rafter|roof\s*truss|rafter|rafters|truss|trusses|purlin|purlins|ridge|ridge\s*beam|toit|toiture|charpente|charpentes|chevron|chevrons|panne|pannes|faitiere|faîtière|faitage|faîtage|arbaletrier|arbalétrier|ferme|fermes)\b/i.test(searchableText(mesh));
}

function hasColumnHint(mesh) {
  // English + French names commonly found in GLB exports.
  return /\b(column|columns|pillar|pillars|post|posts|colonne|colonnes|poteau|poteaux|pilier|piliers|potelet|potelets)\b/i.test(searchableText(mesh));
}

function hasStairHint(mesh) {
  // Keep both accented and non-accented French terms.
  return /\b(stair|stairs|staircase|stairway|step|steps|escalier|escaliers|marche|marches|emmarchement|emmarchements|volee|volée|volees|volées|contremarche|contremarches|giron|girons)\b/i.test(searchableText(mesh));
}

function clusterLevels(values, tolerance = STOREY_LEVEL_TOLERANCE) {
  const sorted = values
    .filter(v => Number.isFinite(v.y))
    .sort((a, b) => a.y - b.y);
  if (sorted.length === 0) return [];

  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const cluster = clusters[clusters.length - 1];
    const clusterY = weightedAverage(cluster);
    if (Math.abs(sorted[i].y - clusterY) <= tolerance) cluster.push(sorted[i]);
    else clusters.push([sorted[i]]);
  }
  return clusters;
}

function weightedAverage(cluster) {
  const totalWeight = cluster.reduce((sum, item) => sum + item.weight, 0) || 1;
  return cluster.reduce((sum, item) => sum + item.y * item.weight, 0) / totalWeight;
}

function dedupeStoreyLevels(levels) {
  const deduped = [];
  for (const level of levels.sort((a, b) => a - b)) {
    if (deduped.length === 0 || level - deduped[deduped.length - 1] >= MIN_STOREY_HEIGHT) {
      deduped.push(level);
    }
  }
  return deduped;
}

function floorForY(y, storeys) {
  if (!storeys || storeys.length === 0) return { elevation: 0, name: 'Storey 0' };
  let current = storeys[0];
  for (const storey of storeys) {
    if (storey.elevation <= y + 0.15) current = storey;
    else break;
  }
  return current;
}

function bboxOverlapsXZ(a, b, tol = 0) {
  const A = bboxStats(a);
  const B = bboxStats(b);
  return (A.minX < B.maxX + tol && A.maxX > B.minX - tol &&
          A.minZ < B.maxZ + tol && A.maxZ > B.minZ - tol);
}

function bboxOverlapRatioXZ(candidate, host, tol = 0) {
  const C = bboxStats(candidate);
  const H = bboxStats(host);
  const ix = Math.max(0, Math.min(C.maxX, H.maxX + tol) - Math.max(C.minX, H.minX - tol));
  const iz = Math.max(0, Math.min(C.maxZ, H.maxZ + tol) - Math.max(C.minZ, H.minZ - tol));
  const candidateArea = Math.max(0.0001, C.sizeX * C.sizeZ);
  return (ix * iz) / candidateArea;
}

function triangleFaceAnalysis(mesh) {
  if (mesh.faceAnalysis) return mesh.faceAnalysis;

  let totalArea = 0;
  let verticalArea = 0;
  let horizontalArea = 0;
  let flatArea = 0;
  let inclinedArea = 0;
  let normalXArea = 0;
  let normalYArea = 0;
  let normalZArea = 0;

  const positions = mesh.positions;
  const indices = mesh.indices;

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;

    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];

    const bx = positions[ib];
    const by = positions[ib + 1];
    const bz = positions[ib + 2];

    const cx = positions[ic];
    const cy = positions[ic + 1];
    const cz = positions[ic + 2];

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;

    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;

    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength < 1e-9) continue;

    const area = normalLength / 2;
    const anx = Math.abs(nx / normalLength);
    const any = Math.abs(ny / normalLength); // Y is vertical in glTF.
    const anz = Math.abs(nz / normalLength);

    totalArea += area;
    normalXArea += anx * area;
    normalYArea += any * area;
    normalZArea += anz * area;

    // A vertical face has a mostly horizontal normal, so abs(normal.y) is small.
    if (any < 0.35) verticalArea += area;

    // A horizontal face has a mostly vertical normal.
    if (any > 0.75) horizontalArea += area;

    // Stricter flatness and sloped roof-like areas. A roof pitch of roughly
    // 10–60 degrees produces a vertical component below ~0.98 and above ~0.5,
    // but we keep the band wider to survive noisy triangulation.
    if (any > 0.95) flatArea += area;
    if (any >= 0.25 && any <= 0.95) inclinedArea += area;
  }

  const safeTotal = Math.max(totalArea, 1e-9);

  mesh.faceAnalysis = {
    totalArea,
    verticalArea,
    horizontalArea,
    verticalRatio: verticalArea / safeTotal,
    horizontalRatio: horizontalArea / safeTotal,
    flatRatio: flatArea / safeTotal,
    inclinedRatio: inclinedArea / safeTotal,
    normalXRatio: normalXArea / safeTotal,
    normalYRatio: normalYArea / safeTotal,
    normalZRatio: normalZArea / safeTotal
  };

  return mesh.faceAnalysis;
}


function horizontalFaceLevels(mesh) {
  if (mesh.horizontalFaceLevels) return mesh.horizontalFaceLevels;

  const positions = mesh.positions;
  const indices = mesh.indices;
  const samples = [];
  let totalHorizontalArea = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;

    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;

    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength < 1e-9) continue;

    const area = normalLength / 2;
    const any = Math.abs(ny / normalLength);

    // Horizontal tread/landing-like faces. Filter out tiny triangles so noisy
    // bevels or triangulated decoration do not create fake stair levels.
    if (any >= 0.78 && area >= 0.01) {
      const y = (ay + by + cy) / 3;
      samples.push({ y, weight: area, area });
      totalHorizontalArea += area;
    }
  }

  const clusters = clusterLevels(samples, 0.08)
    .map(cluster => ({
      y: weightedAverage(cluster),
      area: cluster.reduce((sum, item) => sum + item.area, 0),
      count: cluster.length
    }))
    .filter(cluster => cluster.area >= Math.max(0.03, totalHorizontalArea * 0.015))
    .sort((a, b) => a.y - b.y);

  const yMin = clusters.length > 0 ? clusters[0].y : 0;
  const yMax = clusters.length > 0 ? clusters[clusters.length - 1].y : 0;
  const gaps = [];
  for (let i = 1; i < clusters.length; i++) gaps.push(clusters[i].y - clusters[i - 1].y);

  mesh.horizontalFaceLevels = {
    clusters,
    count: clusters.length,
    yMin,
    yMax,
    ySpan: yMax - yMin,
    totalHorizontalArea,
    avgGap: gaps.length > 0 ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0
  };

  return mesh.horizontalFaceLevels;
}

function looksLikeStair(mesh) {
  const s = bboxStats(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh) || hasBeamHint(mesh) || hasRoofHint(mesh)) return false;

  const explicitStair = hasStairHint(mesh);

  // Key fix: don't classify large vertical wall surfaces as stairs just
  // because openings create several horizontal ledges.
  if (!explicitStair && looksLikeDominantWallPlane(mesh)) {
    mesh.stairRejectionReason = 'dominant_wall_plane';
    return false;
  }

  const confidence = stairStepConfidence(mesh);

  if (explicitStair) {
    return s.horizontal >= 0.45 && s.sizeY >= 0.08 && confidence >= 1.8;
  }

  return confidence >= 4.4;
}

function looksLikeColumn(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh) || hasBeamHint(mesh) || hasRoofHint(mesh) || hasStairHint(mesh)) return false;

  const planMax = Math.max(s.sizeX, s.sizeZ);
  const planMin = Math.min(s.sizeX, s.sizeZ);
  const planAspect = planMax / Math.max(planMin, 0.001);

  const namedColumn =
    hasColumnHint(mesh) &&
    s.sizeY >= 0.7 &&
    planMax <= 1.8 &&
    planMin >= 0.04 &&
    planAspect <= 5.0;

  // Generic column/post: compact footprint + tall vertical object. The aspect
  // cap prevents doors, thin wall strips and façade mullions from becoming
  // columns too easily.
  const compactVertical =
    s.sizeY >= 1.3 &&
    planMax >= 0.10 &&
    planMax <= 1.15 &&
    planMin >= 0.08 &&
    planAspect <= 3.2 &&
    s.sizeY / Math.max(planMax, 0.001) >= 1.8 &&
    s.areaXZ <= 1.35 &&
    f.verticalRatio >= 0.28;

  if (namedColumn || compactVertical) {
    mesh.columnDetectionReason = namedColumn ? 'named_column' : 'compact_vertical_member';
    return true;
  }

  return false;
}


function slopedBeamMetrics(mesh) {
  const s = bboxStats(mesh);

  // Sloped rafters / roof beams can have a large vertical bbox because their
  // long axis is diagonal. Axis-aligned bbox rules then mistake them for walls.
  // We therefore inspect the 2D section made by the long horizontal axis and Y:
  // a sloped beam is long along a diagonal but very narrow perpendicular to it.
  const useZLongAxis = s.sizeX <= 0.35 && s.sizeZ >= 0.9 && s.sizeY >= 0.25;
  const useXLongAxis = s.sizeZ <= 0.35 && s.sizeX >= 0.9 && s.sizeY >= 0.25;

  if (!useZLongAxis && !useXLongAxis) return null;

  const positions = mesh.positions;
  const samples = [];

  for (let i = 0; i < positions.length; i += 3) {
    samples.push({
      h: useZLongAxis ? positions[i + 2] : positions[i],
      y: positions[i + 1]
    });
  }

  const hValues = samples.map(p => p.h);
  const yValues = samples.map(p => p.y);
  const hSpan = Math.max(...hValues) - Math.min(...hValues);
  const ySpan = Math.max(...yValues) - Math.min(...yValues);

  if (hSpan <= 0 || ySpan <= 0) return null;

  function perpendicularSpan(sign = 1) {
    const uxRaw = hSpan;
    const uyRaw = sign * ySpan;
    const len = Math.hypot(uxRaw, uyRaw);
    const vx = -uyRaw / len;
    const vy = uxRaw / len;

    const projected = samples.map(p => p.h * vx + p.y * vy);
    return Math.max(...projected) - Math.min(...projected);
  }

  const perpSpan = Math.min(perpendicularSpan(1), perpendicularSpan(-1));
  const sideThickness = useZLongAxis ? s.sizeX : s.sizeZ;
  const diagonalLength = Math.hypot(hSpan, ySpan);
  const slope = ySpan / Math.max(hSpan, 0.001);
  const maxCrossSection = Math.max(sideThickness, perpSpan);

  return {
    sideThickness,
    perpSpan,
    diagonalLength,
    slope,
    hSpan,
    ySpan,
    slenderness: diagonalLength / Math.max(maxCrossSection, 0.001)
  };
}

function looksLikeSlopedBeam(mesh) {
  const m = slopedBeamMetrics(mesh);
  if (!m) return false;

  return (
    m.sideThickness >= 0.025 &&
    m.sideThickness <= 0.35 &&
    m.perpSpan <= 0.38 &&
    m.diagonalLength >= 1.2 &&
    m.slope >= 0.05 &&
    m.slope <= 2.2 &&
    m.slenderness >= 6.0
  );
}

function looksLikeBeam(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh) || hasColumnHint(mesh) || hasStairHint(mesh)) return false;

  // A generic "roof" surface should remain a roof, but roof-structure names
  // such as rafter / chevron / panne / charpente can still be beams.
  const roofOnly = hasRoofHint(mesh) && !hasBeamHint(mesh) && !hasRoofStructureHint(mesh);
  if (roofOnly) return false;

  const length = s.horizontal;
  const width = s.minHoriz;
  const height = s.sizeY;

  // Named beams are strong signals, but still require plausible dimensions.
  const namedBeam =
    hasBeamHint(mesh) &&
    length >= 0.5 &&
    height >= 0.05 &&
    height <= 1.5 &&
    width <= 1.2;

  // Generic beams: elongated, horizontal, modest cross-section, with enough
  // vertical side faces to avoid classifying paper-thin strips or floor slabs.
  const elongated = length >= 1.0 && length / Math.max(width, height, 0.001) >= 3.0;
  const crossSectionOk = width >= 0.04 && width <= 0.9 && height >= 0.08 && height <= 0.9;
  const notHugePanel = s.areaXZ <= Math.max(12, length * 1.2);
  const hasBeamFaces = f.verticalRatio >= 0.25;

  const slopedBeam = looksLikeSlopedBeam(mesh);

  if (namedBeam || slopedBeam || (elongated && crossSectionOk && notHugePanel && hasBeamFaces)) {
    mesh.beamDetectionReason = namedBeam
      ? 'named_beam'
      : (slopedBeam ? 'sloped_oriented_member' : 'elongated_horizontal_member');
    return true;
  }

  return false;
}

function looksLikeRoofCandidate(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh) || hasBeamHint(mesh)) return false;
  if (s.horizontal < 0.8 || s.areaXZ < 0.8) return false;

  const namedRoof = hasRoofHint(mesh);

  // Sloped roof: significant inclined area, not mostly vertical like a wall.
  const slopedRoof =
    f.inclinedRatio >= 0.28 &&
    f.verticalRatio <= 0.55 &&
    s.sizeY >= 0.12 &&
    s.horizontal >= 1.0;

  // Flat roof candidates are handled later, because we need the global top of
  // the building to distinguish them from intermediate floor slabs.
  const flatRoofCandidate =
    f.flatRatio >= 0.45 &&
    s.sizeY < 0.7 &&
    s.areaXZ >= 2.0;

  if (namedRoof || slopedRoof || flatRoofCandidate) {
    mesh.roofCandidate = true;
    mesh.roofDetectionReason = namedRoof ? 'named_roof' : (slopedRoof ? 'sloped_surface' : 'flat_top_candidate');
    return true;
  }

  return false;
}

function hasSimilarStackedOpeningPanel(candidate, candidates) {
  const c = bboxStats(candidate);

  // Very thin panels of the same plan position repeated on several storeys are
  // much more likely to be windows than walls. This catches old-house windows
  // that start close to the storey level and would otherwise be read as doors
  // or thin wall fragments.
  if (c.minHoriz > 0.20) return false;
  if (c.horizontal < 0.45 || c.horizontal > 3.2) return false;
  if (c.sizeY < 0.55 || c.sizeY > 2.25) return false;

  return candidates.some(other => {
    if (other === candidate) return false;

    const o = bboxStats(other);

    if (o.minHoriz > 0.22) return false;
    if (o.horizontal < 0.45 || o.horizontal > 3.2) return false;
    if (o.sizeY < 0.55 || o.sizeY > 2.35) return false;

    const samePlan =
      bboxOverlapsXZ(candidate, other, 0.12) &&
      bboxOverlapRatioXZ(candidate, other, 0.12) >= 0.60 &&
      bboxOverlapRatioXZ(other, candidate, 0.12) >= 0.60;

    const similarWidth = Math.abs(c.horizontal - o.horizontal) <= Math.max(0.20, c.horizontal * 0.18);
    const similarThickness = Math.abs(c.minHoriz - o.minHoriz) <= 0.12;
    const verticallySeparated = Math.abs(c.centerY - o.centerY) >= 0.75;

    return samePlan && similarWidth && similarThickness && verticallySeparated;
  });
}

function looksLikeWindowPanel(candidate, candidates, storeys, hostWall = null) {
  const s = bboxStats(candidate);

  if (hasDoorHint(candidate)) return false;
  if (hasBeamHint(candidate) || hasColumnHint(candidate) || hasStairHint(candidate) || hasRoofHint(candidate)) return false;

  const veryThinPanel = s.minHoriz <= 0.20;
  const plausibleWindowSize =
    s.sizeY >= 0.55 &&
    s.sizeY <= 2.25 &&
    s.horizontal >= 0.45 &&
    s.horizontal <= 3.2;

  if (!veryThinPanel || !plausibleWindowSize) return false;

  const floor = floorForY(s.minY, storeys);
  const floorIdx = storeys.indexOf(floor);
  const bottomOffset = s.minY - floor.elevation;

  const repeatedPanel = hasSimilarStackedOpeningPanel(candidate, candidates);
  const explicitWindow = hasWindowHint(candidate) || candidate.opacity < 0.65;
  const externalLikeHost = Boolean(
    hostWall &&
    (hostWall.likelyExternalWall || hasExteriorWallHint(hostWall) || hostWall.wallDetectionReason === 'vertical_facade')
  );

  // Tall old-building windows can start slightly below or very close to the
  // detected storey elevation due to thick floors/sills. Without this rule,
  // they are often classified as doors or walls.
  const upperStoreyTallWindowPanel =
    floorIdx > 0 &&
    s.horizontal >= 0.95 &&
    s.sizeY <= 2.10 &&
    bottomOffset >= -0.25 &&
    bottomOffset <= 0.30 &&
    (externalLikeHost || repeatedPanel);

  if (explicitWindow || repeatedPanel || upperStoreyTallWindowPanel) {
    candidate.windowDetectionReason = explicitWindow
      ? 'window_hint_or_glass'
      : (repeatedPanel ? 'stacked_thin_panel' : 'upper_storey_thin_panel');
    return true;
  }

  return false;
}

function looksLikeVerticalFacadeOrWall(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);

  mesh.wallDetectionReason = mesh.wallDetectionReason || '';
  mesh.likelyExternalWall = mesh.likelyExternalWall || false;

  if (hasDoorHint(mesh) || hasWindowHint(mesh)) return false;
  if (s.sizeY < 1.4) return false;
  if (s.horizontal < 0.7) return false;
  if (f.totalArea < 0.5) return false;

  // Classic wall: thin in plan, large vertical surface.
  const thinWall = s.minHoriz < 0.75 && f.verticalRatio >= 0.35;

  // Thick / old wall or low facade segment:
  // Some real walls in old buildings are around 0.70–1.00m thick and may be
  // below the 1.80m facade threshold because they are parapets, attic walls,
  // gable fragments, or short wall sections. They should still become IfcWall
  // when they are elongated and dominated by vertical faces.
  const thickElongatedWall =
    s.sizeY >= 1.15 &&
    s.minHoriz <= 1.05 &&
    s.horizontal >= 1.5 &&
    s.horizontal / Math.max(s.minHoriz, 0.001) >= 3.0 &&
    f.verticalRatio >= 0.52 &&
    f.horizontalRatio <= 0.48;

  // Facade-like objects can have a large bounding box on both X and Z because
  // several exterior wall segments are merged into one mesh. They still have a
  // strong vertical-face signature and relatively little horizontal area.
  const facadeLike =
    f.verticalRatio >= 0.55 &&
    f.horizontalRatio <= 0.40 &&
    s.sizeY >= 1.6 &&
    s.horizontal >= 1.2;

  // Helpful for exports where walls are explicitly named but not geometrically
  // thin because trims/cladding/opening returns are merged into the same mesh.
  const namedWall = hasWallHint(mesh) && f.verticalRatio >= 0.3 && s.sizeY >= 1.2;

  if (thinWall) {
    mesh.wallDetectionReason = 'thin_wall';
    if (hasExteriorWallHint(mesh)) mesh.likelyExternalWall = true;
    return true;
  }

  if (thickElongatedWall) {
    mesh.wallDetectionReason = 'thick_elongated_wall';
    if (hasExteriorWallHint(mesh)) mesh.likelyExternalWall = true;
    return true;
  }

  if (facadeLike) {
    mesh.wallDetectionReason = 'vertical_facade';
    // This is intentionally generous: a merged vertical facade is usually part
    // of the envelope, and the user can still rely on Pset_WallCommon.IsExternal
    // to identify it downstream.
    mesh.likelyExternalWall = true;
    return true;
  }

  if (namedWall) {
    mesh.wallDetectionReason = 'named_wall';
    if (hasExteriorWallHint(mesh)) mesh.likelyExternalWall = true;
    return true;
  }

  return false;
}

function looksLikeDominantWallPlane(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh)) return false;

  const longDim = Math.max(s.sizeX, s.sizeZ);
  const thickDim = Math.min(s.sizeX, s.sizeZ);
  const aspect = longDim / Math.max(thickDim, 0.001);

  // Robust wall signal:
  // walls with several openings can have many ledges, so we use overall
  // vertical dominance + plan proportions to protect them from stair detection.
  const wallByProportion =
    s.sizeY >= 1.45 &&
    longDim >= 1.50 &&
    thickDim <= 1.25 &&
    aspect >= 2.0 &&
    f.verticalRatio >= 0.45;

  const largeVerticalSurface =
    s.sizeY >= 1.70 &&
    longDim >= 2.0 &&
    f.verticalArea >= 4.0 &&
    f.verticalRatio >= 0.52 &&
    aspect >= 1.65;

  const namedWall =
    hasWallHint(mesh) &&
    s.sizeY >= 1.25 &&
    longDim >= 1.0 &&
    f.verticalRatio >= 0.35;

  // A real stair named "stair/escalier" can still pass later, but if the object
  // is overwhelmingly wall-like, the wall should win.
  if (hasStairHint(mesh) && !(largeVerticalSurface && aspect >= 2.4)) {
    return false;
  }

  if (wallByProportion || largeVerticalSurface || namedWall) {
    mesh.wallLikeReason = wallByProportion
      ? 'wall_by_proportion'
      : largeVerticalSurface
        ? 'large_vertical_surface'
        : 'wall_name_hint';
    return true;
  }

  return false;
}

function stairStepConfidence(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);
  const levels = horizontalFaceLevels(mesh);

  if (levels.length < 4) return 0;

  const longDim = Math.max(s.sizeX, s.sizeZ);
  const thickDim = Math.min(s.sizeX, s.sizeZ);
  const aspect = longDim / Math.max(thickDim, 0.001);

  const diffs = [];
  for (let i = 1; i < levels.length; i++) {
    diffs.push(Math.abs(levels[i] - levels[i - 1]));
  }

  const plausibleRisers = diffs.filter(d => d >= 0.08 && d <= 0.32).length;
  const riserRatio = plausibleRisers / Math.max(diffs.length, 1);

  let confidence = 0;

  confidence += Math.min(levels.length - 1, 5) * 0.65;
  confidence += riserRatio >= 0.60 ? 2.2 : riserRatio >= 0.40 ? 0.9 : 0;
  confidence += f.horizontalRatio >= 0.24 ? 1.2 : f.horizontalRatio >= 0.16 ? 0.4 : 0;
  confidence += s.sizeY >= 0.35 && s.sizeY <= 4.5 ? 0.7 : 0;
  confidence += longDim >= 0.9 ? 0.5 : 0;

  // Penalize vertical-wall dominance.
  if (aspect >= 2.0 && s.sizeY >= 1.45 && f.verticalRatio >= 0.45) confidence -= 2.4;
  if (looksLikeDominantWallPlane(mesh)) confidence -= 4.5;

  if (hasStairHint(mesh)) confidence += 3.0;
  if (hasWallHint(mesh)) confidence -= 2.0;

  mesh.stairStepConfidence = confidence;
  mesh.stairStepLevels = levels.length;
  mesh.stairRiserRatio = riserRatio;

  return confidence;
}

function classifyMeshFirstPass(mesh) {
  const s = bboxStats(mesh);

  // Strong name/material hints first.
  if ((hasDoorHint(mesh) || hasWindowHint(mesh)) && s.minHoriz < 0.7) return 'proxy';

  if (hasRoofHint(mesh) && looksLikeRoofCandidate(mesh)) {
    mesh.isExternal = true;
    return 'roof';
  }

  if (looksLikeDominantWallPlane(mesh)) {
    return 'wall_candidate';
  }

  if (looksLikeStair(mesh)) {
    return 'stair';
  }

  if (looksLikeBeam(mesh)) {
    return 'beam';
  }

  if (looksLikeColumn(mesh)) {
    return 'column';
  }

  if (hasSlabHint(mesh) && s.sizeY < 0.8 && s.horizontal > 0.8) return 'slab';

  // Sloped roofs are held as roof candidates and promoted later only if they
  // sit near the top of the building. This avoids confusing ramps/stairs with
  // roofs in the first pass.
  looksLikeRoofCandidate(mesh);

  // Slab: flat & wide. Keep the threshold permissive; storey detection filters
  // small flat furniture later so tables do not become building storeys.
  if (s.sizeY < 0.5 && s.horizontal > 1.0 && s.sizeY / Math.max(s.horizontal, 0.001) < 0.2) {
    return 'slab';
  }

  // Wall candidate: tall, thin on one horizontal axis, longer on the other.
  // Short door/window panels can also match this shape, so refineOpenings() is
  // allowed to reclassify wall_candidates when there is a larger host wall.
  if ((hasWallHint(mesh) || s.sizeY > 1.0) && s.minHoriz < 0.6 && s.horizontal / Math.max(s.minHoriz, 0.001) > 2) {
    mesh.wallDetectionReason = 'bbox_wall';
    mesh.likelyExternalWall = hasExteriorWallHint(mesh);
    return 'wall_candidate';
  }

  // Exterior walls/facades are often exported as merged, non-thin meshes. The
  // bounding box alone misses them, so use triangle normals: if most of the
  // mesh area is vertical, it is more likely a wall/facade than furniture.
  if (looksLikeVerticalFacadeOrWall(mesh)) {
    return 'wall_candidate';
  }

  return 'proxy';
}

/**
 * Refine classification by detecting doors and windows.
 *
 * Important difference from the first version: opening candidates are not only
 * proxies. A separate door leaf/window pane is often tall + thin enough to be
 * classified as a wall_candidate, so we also inspect small wall_candidates and
 * reclassify them when they overlap a larger host wall.
 */
function refineOpenings(meshes, storeys = []) {
  const walls = meshes.filter(m => m.classification === 'wall_candidate');
  const candidates = meshes.filter(m => m.classification === 'proxy' || m.classification === 'wall_candidate');

  for (const candidate of candidates) {
    const s = bboxStats(candidate);
    const doorHint = hasDoorHint(candidate);
    const windowHint = hasWindowHint(candidate) || candidate.opacity < 0.65;
    const hint = doorHint || windowHint;

    // Must be reasonably thin and opening-sized. Hints relax the limits a bit,
    // useful for named objects such as "Porte_90" or "Glass_Window".
    if (s.minHoriz > (hint ? 0.75 : 0.55)) continue;
    if (s.horizontal < 0.25 || s.horizontal > (hint ? 5.5 : 4.0)) continue;
    if (s.sizeY < 0.25 || s.sizeY > (hint ? 3.2 : 2.8)) continue;

    const hostWall = walls
      .filter(wall => wall !== candidate)
      .filter(wall => {
        const w = bboxStats(wall);
        if (w.sizeY < 1.2) return false;
        if (w.horizontal < s.horizontal + 0.2 && !hint) return false;
        return bboxOverlapsXZ(candidate, wall, 0.18) && bboxOverlapRatioXZ(candidate, wall, 0.18) > 0.25;
      })
      .sort((a, b) => bboxOverlapRatioXZ(candidate, b, 0.18) - bboxOverlapRatioXZ(candidate, a, 0.18))[0];

    // Some window panels are separate thin meshes repeated on several storeys.
    // Even if no larger host wall is found, do not promote these to IfcWall.
    if (!hostWall) {
      if (looksLikeWindowPanel(candidate, candidates, storeys, null)) {
        candidate.classification = 'window';
      }
      continue;
    }

    const floor = floorForY(s.minY, storeys);
    const bottomOffset = s.minY - floor.elevation;

    // First, protect window-like panels from being classified as doors. This
    // handles tall upper-storey windows and repeated thin panels that start very
    // close to the detected floor elevation.
    if (looksLikeWindowPanel(candidate, candidates, storeys, hostWall)) {
      candidate.classification = 'window';
      candidate.hostWallName = hostWall.name;
      candidate.hostWall = hostWall;
      continue;
    }

    // Door: full-height-ish and starting at the floor. Allow a small negative
    // offset because some exports put the frame slightly below slab top.
    const looksLikeDoor =
      doorHint ||
      (s.sizeY >= 1.6 && s.sizeY <= 2.8 &&
       s.horizontal >= 0.45 && s.horizontal <= 2.2 &&
       bottomOffset >= -0.15 && bottomOffset <= 0.45);

    if (looksLikeDoor && !windowHint) {
      candidate.classification = 'door';
      candidate.hostWallName = hostWall.name;
      candidate.hostWall = hostWall;
      continue;
    }

    // Window: above floor, not full-height to the floor. Transparent/glass
    // material or explicit names are treated as strong signals.
    const looksLikeWindow =
      windowHint ||
      (s.sizeY >= 0.25 && s.sizeY <= 2.4 &&
       s.horizontal >= 0.3 && s.horizontal <= 4.5 &&
       bottomOffset >= 0.35 && bottomOffset <= 2.4);

    if (looksLikeWindow) {
      candidate.classification = 'window';
      candidate.hostWallName = hostWall.name;
      candidate.hostWall = hostWall;
      continue;
    }
  }

  // Promote remaining wall_candidates after openings have had a chance to move.
  for (const m of meshes) {
    if (m.classification === 'wall_candidate') m.classification = 'wall';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storey detection v2
// ─────────────────────────────────────────────────────────────────────────────

function storeyCandidateWeight(mesh, source) {
  const s = bboxStats(mesh);
  const areaFactor = Math.min(4, Math.sqrt(Math.max(s.areaXZ, 0)) / 2);

  if (source === 'slab_top') return 2.5 + areaFactor + (hasSlabHint(mesh) ? 1.5 : 0);
  if (source === 'wall_base') return 1.5 + Math.min(3, s.horizontal / 4) + (hasWallHint(mesh) ? 0.75 : 0);
  if (source === 'door_base') return 1.5 + (hasDoorHint(mesh) ? 0.5 : 0);
  if (source === 'window_base') return 0.5;
  if (source === 'beam_base') return 0.4;
  if (source === 'column_base') return 1.8 + Math.min(2, s.sizeY / 3) + (hasColumnHint(mesh) ? 0.75 : 0);
  if (source === 'stair_base') return 0.7 + (hasStairHint(mesh) ? 0.6 : 0);

  return 1;
}

function collectStoreyCandidates(meshes) {
  const candidates = [];

  function add(mesh, y, source, extra = {}) {
    if (!Number.isFinite(y)) return;
    candidates.push({
      y,
      source,
      weight: storeyCandidateWeight(mesh, source),
      mesh,
      ...extra
    });
  }

  for (const mesh of meshes) {
    const s = bboxStats(mesh);
    const f = triangleFaceAnalysis(mesh);

    // Floors / slabs: use top elevation as the walking level. Keep only
    // meaningful horizontal surfaces to avoid tables, shelves and trims.
    if (mesh.classification === 'slab') {
      const likelyFloor = s.areaXZ >= 2.0 || hasSlabHint(mesh);
      if (likelyFloor) {
        add(mesh, s.maxY, 'slab_top', {
          areaXZ: s.areaXZ,
          horizontalRatio: f.horizontalRatio
        });
      }
    }

    // Strongest signal: many vertical elements starting at the same altitude.
    // This catches models with no clean floor slabs.
    if (mesh.classification === 'wall' || mesh.classification === 'wall_candidate') {
      if (s.sizeY >= 1.2 && s.horizontal >= 0.5) {
        add(mesh, s.minY, 'wall_base', {
          length: s.horizontal,
          areaXZ: s.areaXZ
        });
      }
    }

    // Doors are useful because they normally start very close to floor level.
    if (mesh.classification === 'door') {
      add(mesh, s.minY, 'door_base', {
        areaXZ: s.areaXZ
      });
    }

    // Weak hint only. Windows can help in sparse models, but should not create
    // storeys by themselves.
    if (mesh.classification === 'window') {
      add(mesh, s.minY, 'window_base', {
        areaXZ: s.areaXZ
      });
    }

    // Weak hint only: beams can sit close to ceilings, so never let them drive
    // storeys alone.
    if (mesh.classification === 'beam') {
      add(mesh, s.minY, 'beam_base', {
        areaXZ: s.areaXZ
      });
    }

    // Columns/posts are a useful storey signal in models with structural frames
    // but no clean slabs. Stairs are only a weak hint because they can span two
    // levels.
    if (mesh.classification === 'column') {
      add(mesh, s.minY, 'column_base', {
        areaXZ: s.areaXZ
      });
    }

    if (mesh.classification === 'stair') {
      add(mesh, s.minY, 'stair_base', {
        areaXZ: s.areaXZ
      });
    }
  }

  return candidates;
}

function summarizeStoreyCluster(cluster) {
  const y = weightedAverage(cluster);
  const score = cluster.reduce((sum, c) => sum + c.weight, 0);
  const sourceCounts = {};
  let horizontalArea = 0;
  let wallLength = 0;

  for (const c of cluster) {
    sourceCounts[c.source] = (sourceCounts[c.source] || 0) + 1;
    if (c.source === 'slab_top') horizontalArea += c.areaXZ || 0;
    if (c.source === 'wall_base') wallLength += c.length || 0;
  }

  const hasVerticalBase = Boolean(sourceCounts.wall_base || sourceCounts.door_base || sourceCounts.column_base);
  const hasSlab = Boolean(sourceCounts.slab_top);
  const weakOnly = !hasVerticalBase && !hasSlab;

  return {
    y,
    score,
    sourceCounts,
    horizontalArea,
    wallLength,
    hasVerticalBase,
    hasSlab,
    weakOnly,
    support: cluster.length
  };
}

function sourceSummary(sourceCounts) {
  return Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source}:${count}`)
    .join(', ');
}

function confidenceFromScore(score) {
  // Logistic-ish mapping into a readable 0.00–0.99 confidence.
  return Math.max(0.05, Math.min(0.99, score / (score + 8)));
}

function selectStoreyLevels(clusterSummaries) {
  const sorted = clusterSummaries
    .filter(c => Number.isFinite(c.y))
    .sort((a, b) => a.y - b.y);

  if (sorted.length === 0) return { accepted: [], ignored: [] };

  const hasAnyVerticalBase = sorted.some(c => c.hasVerticalBase);
  const accepted = [];
  const ignored = [];

  for (const candidate of sorted) {
    const isFirstAccepted = accepted.length === 0;

    // Be careful with ceilings: if the model has wall/door bases, a level made
    // only from a slab should normally not create a storey unless it is a large
    // floor plate. This keeps false mezzanines/ceilings down while still
    // supporting slab-only models.
    const slabOnlyButUseful = candidate.hasSlab && (
      !hasAnyVerticalBase ||
      candidate.horizontalArea >= 10 ||
      isFirstAccepted
    );

    const acceptable =
      candidate.score >= STOREY_MIN_SCORE &&
      !candidate.weakOnly &&
      (candidate.hasVerticalBase || slabOnlyButUseful);

    if (!acceptable) {
      ignored.push({ ...candidate, reason: 'weak_or_ceiling_like' });
      continue;
    }

    if (accepted.length === 0) {
      accepted.push(candidate);
      continue;
    }

    const previous = accepted[accepted.length - 1];
    const gap = candidate.y - previous.y;

    if (gap < MIN_STOREY_HEIGHT) {
      // If two levels are too close, keep the one with stronger evidence. This
      // often collapses slab underside/top noise or ceiling surfaces.
      if (candidate.score > previous.score * 1.25 && candidate.hasVerticalBase) {
        ignored.push({ ...previous, reason: `too_close_to_${candidate.y.toFixed(2)}m` });
        accepted[accepted.length - 1] = candidate;
      } else {
        ignored.push({ ...candidate, reason: `too_close_to_${previous.y.toFixed(2)}m` });
      }
      continue;
    }

    accepted.push(candidate);
  }

  // Avoid pathological empty output.
  if (accepted.length === 0 && sorted.length > 0) {
    const strongest = [...sorted].sort((a, b) => b.score - a.score)[0];
    accepted.push(strongest);
  }

  return { accepted, ignored };
}

function detectStoreys(meshes) {
  const candidates = collectStoreyCandidates(meshes);

  if (candidates.length === 0) {
    return [{ elevation: 0, name: 'Storey 0', confidence: 0.5, score: 0, sourceSummary: 'default' }];
  }

  const clusters = clusterLevels(candidates, STOREY_LEVEL_TOLERANCE)
    .map(cluster => summarizeStoreyCluster(cluster));

  const { accepted, ignored } = selectStoreyLevels(clusters);

  const storeys = accepted.map((level, idx) => ({
    elevation: level.y,
    name: `Storey ${idx}`,
    confidence: confidenceFromScore(level.score),
    score: level.score,
    sourceSummary: sourceSummary(level.sourceCounts),
    support: level.support
  }));

  // Attach debug info directly on the array. Existing code treats this as a
  // normal array, while the logs can still inspect what happened.
  storeys.ignoredCandidates = ignored
    .sort((a, b) => a.y - b.y)
    .map(level => ({
      elevation: level.y,
      score: level.score,
      reason: level.reason,
      sourceSummary: sourceSummary(level.sourceCounts)
    }));

  storeys.rawCandidateCount = candidates.length;

  return storeys.length > 0
    ? storeys
    : [{ elevation: 0, name: 'Storey 0', confidence: 0.5, score: 0, sourceSummary: 'fallback' }];
}

const STOREY_ASSIGNMENT_TOLERANCE = 0.15;
const STOREY_UPWARD_SNAP_TOLERANCE = 0.45;

function storeyIndexByFloorY(y, storeys, tolerance = STOREY_ASSIGNMENT_TOLERANCE) {
  if (!storeys || storeys.length === 0) return 0;

  let idx = 0;

  for (let i = 0; i < storeys.length; i++) {
    if (storeys[i].elevation <= y + tolerance) idx = i;
    else break;
  }

  return idx;
}

function storeyIndexByVerticalBand(y, storeys) {
  if (!storeys || storeys.length === 0) return 0;
  if (storeys.length === 1) return 0;

  for (let i = 0; i < storeys.length; i++) {
    const lower = i === 0
      ? -Infinity
      : (storeys[i - 1].elevation + storeys[i].elevation) / 2;

    const upper = i === storeys.length - 1
      ? Infinity
      : (storeys[i].elevation + storeys[i + 1].elevation) / 2;

    if (y >= lower && y < upper) return i;
  }

  return storeys.length - 1;
}

function assignStoreys(meshes, storeys) {
  for (const mesh of meshes) {
    const s = bboxStats(mesh);

    // Storey assignment is intentionally hybrid:
    // - vertical elements start from their base, to avoid assigning a tall ground
    //   floor wall to the upper storey just because its centre is high;
    // - but if the base is only slightly below the next storey elevation and the
    //   element mostly lives above that level, we snap it upward. This handles
    //   old/thick buildings where wall/window/beam geometry can start 25-45cm
    //   below the detected finished-floor elevation.
    // - beams/slabs/roofs are assigned by vertical band around their centre,
    //   which better matches review expectations for elements near upper floors.
    const cls = mesh.classification;

    let idx;

    if (cls === 'beam' || cls === 'slab' || cls === 'roof') {
      idx = storeyIndexByVerticalBand(s.centerY, storeys);
      mesh.storeyAssignmentReason = 'vertical_band_center';
    } else if (cls === 'stair') {
      idx = storeyIndexByFloorY(s.minY + 0.05, storeys);
      mesh.storeyAssignmentReason = 'stair_base';
    } else if (['wall', 'door', 'window', 'column'].includes(cls)) {
      idx = storeyIndexByFloorY(s.minY + 0.05, storeys);
      mesh.storeyAssignmentReason = 'vertical_base';

      const next = storeys[idx + 1];

      if (next) {
        const distanceBelowNext = next.elevation - s.minY;
        const nearNextStoreyBase =
          distanceBelowNext >= 0 &&
          distanceBelowNext <= STOREY_UPWARD_SNAP_TOLERANCE;

        const height = Math.max(0.001, s.sizeY);
        const aboveNextRatio = Math.max(0, s.maxY - next.elevation) / height;
        const centerBandIdx = storeyIndexByVerticalBand(s.centerY, storeys);

        const shouldSnapUp =
          nearNextStoreyBase &&
          (
            centerBandIdx >= idx + 1 ||
            aboveNextRatio >= 0.35 ||
            s.maxY >= next.elevation + 0.05
          );

        if (shouldSnapUp) {
          idx = idx + 1;
          mesh.storeyAssignmentReason = 'snapped_up_near_next_storey';
        }
      }
    } else {
      idx = storeyIndexByVerticalBand(s.centerY, storeys);
      mesh.storeyAssignmentReason = 'fallback_vertical_band';
    }

    mesh.storeyIndex = Math.max(0, Math.min(idx, storeys.length - 1));
  }
}

function unionBounds(meshes) {
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  };

  for (const mesh of meshes) {
    const s = bboxStats(mesh);
    bounds.minX = Math.min(bounds.minX, s.minX);
    bounds.maxX = Math.max(bounds.maxX, s.maxX);
    bounds.minZ = Math.min(bounds.minZ, s.minZ);
    bounds.maxZ = Math.max(bounds.maxZ, s.maxZ);
  }

  return bounds;
}

function isFiniteBounds(bounds) {
  return [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite);
}

function touchesEnvelopeSide(stats, bounds, tolerance) {
  const nearMinX = Math.abs(stats.minX - bounds.minX) <= tolerance;
  const nearMaxX = Math.abs(stats.maxX - bounds.maxX) <= tolerance;
  const nearMinZ = Math.abs(stats.minZ - bounds.minZ) <= tolerance;
  const nearMaxZ = Math.abs(stats.maxZ - bounds.maxZ) <= tolerance;

  return { nearMinX, nearMaxX, nearMinZ, nearMaxZ };
}

function markExternalWalls(meshes, storeys) {
  const walls = meshes.filter(m => m.classification === 'wall');

  for (const wall of walls) {
    wall.isExternal = false;
  }

  if (walls.length === 0) return;

  const storeyIndexes = storeys.map((_, idx) => idx);

  for (const storeyIndex of storeyIndexes) {
    const storeyWalls = walls.filter(w => w.storeyIndex === storeyIndex);
    if (storeyWalls.length === 0) continue;

    const storeySlabs = meshes
      .filter(m => m.storeyIndex === storeyIndex && m.classification === 'slab')
      .filter(m => bboxStats(m).areaXZ >= 2.0);

    const wallBounds = unionBounds(storeyWalls);
    const slabBounds = storeySlabs.length > 0 ? unionBounds(storeySlabs) : null;
    const boundsCandidates = [wallBounds, slabBounds].filter(b => b && isFiniteBounds(b));

    if (boundsCandidates.length === 0) continue;

    for (const wall of storeyWalls) {
      const s = bboxStats(wall);
      const f = triangleFaceAnalysis(wall);

      const explicitExterior = hasExteriorWallHint(wall);
      const likelyFacadeFromClassification = wall.likelyExternalWall === true;

      const exteriorByEnvelope = boundsCandidates.some(bounds => {
        const width = bounds.maxX - bounds.minX;
        const depth = bounds.maxZ - bounds.minZ;

        // More permissive than the previous version. Slabs may include balconies,
        // thickness offsets or overhangs, so a strict 3% envelope test can mark
        // real facade walls as internal. Use 8%, with sane min/max clamps.
        const tolerance = Math.min(2.5, Math.max(0.45, Math.max(width, depth) * 0.08));
        const near = touchesEnvelopeSide(s, bounds, tolerance);

        const mostlyAlongX = s.sizeX >= s.sizeZ;
        const mostlyAlongZ = s.sizeZ > s.sizeX;
        const complexFacade = s.sizeX > 1.2 && s.sizeZ > 1.2;

        const byOrientation =
          (mostlyAlongX && (near.nearMinZ || near.nearMaxZ)) ||
          (mostlyAlongZ && (near.nearMinX || near.nearMaxX));

        const byMergedFacade =
          complexFacade &&
          (near.nearMinX || near.nearMaxX || near.nearMinZ || near.nearMaxZ);

        return byOrientation || byMergedFacade;
      });

      // If a mesh was classified as a vertical facade and has a strong vertical
      // surface signature, treat it as external even when the envelope test is
      // imperfect. This fixes cases where exterior walls became IFCWALL but the
      // Pset still said IsExternal=false.
      const exteriorByFacadeSignature =
        likelyFacadeFromClassification &&
        f.verticalRatio >= 0.5 &&
        f.horizontalRatio <= 0.45 &&
        s.sizeY >= 1.6;

      wall.isExternal = explicitExterior || exteriorByEnvelope || exteriorByFacadeSignature;
    }
  }
}


function refineRoofs(meshes, storeys) {
  const stats = { promoted: 0 };
  const buildingBounds = meshes.length > 0 ? {
    minY: Math.min(...meshes.map(m => bboxStats(m).minY)),
    maxY: Math.max(...meshes.map(m => bboxStats(m).maxY))
  } : { minY: 0, maxY: 0 };

  const height = Math.max(0.001, buildingBounds.maxY - buildingBounds.minY);
  const topTolerance = Math.min(1.2, Math.max(0.35, height * 0.08));
  const topY = buildingBounds.maxY;

  for (const mesh of meshes) {
    const s = bboxStats(mesh);
    const f = triangleFaceAnalysis(mesh);

    if (mesh.classification === 'door' || mesh.classification === 'window' || mesh.classification === 'wall' || mesh.classification === 'beam' || mesh.classification === 'column' || mesh.classification === 'stair') {
      continue;
    }

    const explicitRoof = hasRoofHint(mesh) || mesh.classification === 'roof';
    const nearTop = s.maxY >= topY - topTolerance;

    const slopedHighRoof =
      mesh.roofCandidate === true &&
      mesh.roofDetectionReason === 'sloped_surface' &&
      nearTop &&
      f.inclinedRatio >= 0.28 &&
      f.verticalRatio <= 0.6;

    const flatHighRoof =
      (mesh.classification === 'slab' || mesh.roofDetectionReason === 'flat_top_candidate') &&
      nearTop &&
      s.sizeY < 0.7 &&
      s.areaXZ >= 2.0 &&
      f.horizontalRatio >= 0.35;

    if (explicitRoof || slopedHighRoof || flatHighRoof) {
      if (mesh.classification !== 'roof') stats.promoted += 1;
      mesh.classification = 'roof';
      mesh.isExternal = true;
      mesh.roofDetectionReason = explicitRoof ? 'named_roof' : (slopedHighRoof ? 'sloped_high_roof' : 'flat_high_roof');
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// IFC generation
// ─────────────────────────────────────────────────────────────────────────────

function ifcGuid() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let s = '';
  for (let i = 0; i < 22; i++) s += chars[Math.floor(Math.random() * 64)];
  return s;
}

const IFC_TYPE_MAP = {
  wall:   { class: 'IFCWALL',                  predefined: '.STANDARD.'   },
  slab:   { class: 'IFCSLAB',                  predefined: '.FLOOR.'      },
  beam:   { class: 'IFCBEAM',                  predefined: '.BEAM.'       },
  column: { class: 'IFCCOLUMN',                predefined: '.COLUMN.'     },
  stair:  { class: 'IFCSTAIR',                 predefined: '.NOTDEFINED.' },
  roof:   { class: 'IFCROOF',                  predefined: '.NOTDEFINED.' },
  proxy:  { class: 'IFCBUILDINGELEMENTPROXY',  predefined: '.NOTDEFINED.' }
  // door & window have different attribute lists, handled inline below
};


// Default visual colors used when the source GLB has no meaningful color
// signal. Many GLBs contain a generic white material on every mesh; treating
// that as an intentional source color makes the IFC look all-white. By default
// we now preserve real/non-neutral GLB colors and fallback to IFC class colors
// for default-looking white/black/grey materials.
// Values are normalized RGB in the 0..1 range for IfcColourRgb.
const DEFAULT_CLASS_COLORS = {
  wall:   { r: 0.76, g: 0.70, b: 0.58 }, // warm plaster / masonry
  slab:   { r: 0.58, g: 0.62, b: 0.66 }, // concrete blue-grey
  beam:   { r: 0.54, g: 0.44, b: 0.32 }, // structural timber/steel neutral
  column: { r: 0.55, g: 0.50, b: 0.62 }, // structural violet-grey
  stair:  { r: 0.74, g: 0.66, b: 0.50 }, // stair sand-grey
  roof:   { r: 0.58, g: 0.17, b: 0.12 }, // roof red/brown
  door:   { r: 0.45, g: 0.25, b: 0.12 }, // wood/brown
  window: { r: 0.35, g: 0.62, b: 0.88 }, // glass blue
  space:  { r: 0.45, g: 0.72, b: 1.00 }, // editable/generated spaces
  proxy:  { r: 0.68, g: 0.72, b: 0.78 }  // neutral blue-grey fallback
};

const PRESERVE_DEFAULT_SOURCE_COLORS = /^(1|true|yes|on)$/i.test(
  String(process.env.GLB2IFC_PRESERVE_DEFAULT_COLORS || '')
);

function isDefaultMaterialName(name) {
  const n = String(name || '').trim().toLowerCase();

  if (!n) return true;

  return /^(material|default|defaultmaterial|mat|none|white|blanc|blanche|untitled)([_. -]?\d+)?$/.test(n);
}

function colorLooksDefault(color) {
  if (!color) return true;

  const r = Number(color.r);
  const g = Number(color.g);
  const b = Number(color.b);

  if (![r, g, b].every(Number.isFinite)) return true;

  const almostWhite = r > 0.94 && g > 0.94 && b > 0.94;
  const almostBlack = r < 0.03 && g < 0.03 && b < 0.03;
  const fullyNeutralDefaultGrey =
    Math.abs(r - g) < 0.01 &&
    Math.abs(g - b) < 0.01 &&
    r >= 0.78 &&
    r <= 0.82;

  return almostWhite || almostBlack || fullyNeutralDefaultGrey;
}

function sourceColorIsUseful(mesh) {
  if (!mesh || !mesh.color) return false;

  // Keep meaningful non-default colors from the GLB.
  if (!colorLooksDefault(mesh.color)) return true;

  // Default-looking white/black/grey materials are usually placeholders in
  // imported GLBs. Use the IFC class palette by default. If a project really
  // wants to preserve those neutral source colors, opt in with:
  // GLB2IFC_PRESERVE_DEFAULT_COLORS=1 bun dev
  if (!PRESERVE_DEFAULT_SOURCE_COLORS) return false;

  return Boolean(mesh.hasSourceMaterial) && !isDefaultMaterialName(mesh.materialName);
}

function colorForMesh(mesh) {
  if (sourceColorIsUseful(mesh)) {
    mesh.usedFallbackColor = false;
    return mesh.color;
  }

  mesh.usedFallbackColor = true;
  return DEFAULT_CLASS_COLORS[mesh.classification] || DEFAULT_CLASS_COLORS.proxy;
}

function generateIFC(meshes, storeys, originalFilename, scaleInfo = null) {
  const lines = [];
  let id = 0;
  const nextId = () => `#${++id}`;

  const now = new Date().toISOString();
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');`,
    `FILE_NAME('${escapeIFCString(originalFilename)}','${now}',(''),(''),'glb2ifc converter','glb2ifc','');`,
    `FILE_SCHEMA(('IFC4'));`,
    'ENDSEC;',
    'DATA;'
  ];

  // Units
  const lenUnit  = nextId(); lines.push(`${lenUnit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  const angUnit  = nextId(); lines.push(`${angUnit}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);
  const areaUnit = nextId(); lines.push(`${areaUnit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
  const volUnit  = nextId(); lines.push(`${volUnit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
  const unitAssignment = nextId();
  lines.push(`${unitAssignment}=IFCUNITASSIGNMENT((${lenUnit},${angUnit},${areaUnit},${volUnit}));`);

  // Common axis placement
  const origin = nextId(); lines.push(`${origin}=IFCCARTESIANPOINT((0.,0.,0.));`);
  const dirZ   = nextId(); lines.push(`${dirZ}=IFCDIRECTION((0.,0.,1.));`);
  const dirX   = nextId(); lines.push(`${dirX}=IFCDIRECTION((1.,0.,0.));`);
  const axis   = nextId(); lines.push(`${axis}=IFCAXIS2PLACEMENT3D(${origin},${dirZ},${dirX});`);

  // Geometry context + sub-context for styled items
  const geomContext = nextId();
  lines.push(`${geomContext}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${axis},$);`);
  const styleContext = nextId();
  lines.push(`${styleContext}=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${geomContext},$,.MODEL_VIEW.,$);`);

  // Owner history
  const person = nextId();      lines.push(`${person}=IFCPERSON($,$,'glb2ifc',$,$,$,$,$);`);
  const org    = nextId();      lines.push(`${org}=IFCORGANIZATION($,'glb2ifc',$,$,$);`);
  const personOrg = nextId();   lines.push(`${personOrg}=IFCPERSONANDORGANIZATION(${person},${org},$);`);
  const application = nextId(); lines.push(`${application}=IFCAPPLICATION(${org},'1.0','glb2ifc','glb2ifc');`);
  const ownerHistory = nextId();
  const timestamp = Math.floor(Date.now() / 1000);
  lines.push(`${ownerHistory}=IFCOWNERHISTORY(${personOrg},${application},$,.ADDED.,${timestamp},${personOrg},${application},${timestamp});`);

  // Project
  const project = nextId();
  lines.push(`${project}=IFCPROJECT('${ifcGuid()}',${ownerHistory},'Project',$,$,$,$,(${geomContext}),${unitAssignment});`);

  // Site
  const sitePlacement = nextId();
  lines.push(`${sitePlacement}=IFCLOCALPLACEMENT($,${axis});`);
  const site = nextId();
  lines.push(`${site}=IFCSITE('${ifcGuid()}',${ownerHistory},'Site',$,$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$);`);

  // Building
  const buildingPlacement = nextId();
  lines.push(`${buildingPlacement}=IFCLOCALPLACEMENT(${sitePlacement},${axis});`);
  const building = nextId();
  lines.push(`${building}=IFCBUILDING('${ifcGuid()}',${ownerHistory},'Building',$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$);`);

  // Storeys
  const storeyEntities = [];
  const storeyPlacements = [];
  for (const storey of storeys) {
    const sPlacement = nextId();
    lines.push(`${sPlacement}=IFCLOCALPLACEMENT(${buildingPlacement},${axis});`);
    storeyPlacements.push(sPlacement);
    const sId = nextId();
    lines.push(`${sId}=IFCBUILDINGSTOREY('${ifcGuid()}',${ownerHistory},'${escapeIFCString(storey.name)}',$,$,${sPlacement},$,$,.ELEMENT.,${storey.elevation.toFixed(4)});`);
    storeyEntities.push(sId);
  }

  // Aggregation
  lines.push(`${nextId()}=IFCRELAGGREGATES('${ifcGuid()}',${ownerHistory},$,$,${project},(${site}));`);
  lines.push(`${nextId()}=IFCRELAGGREGATES('${ifcGuid()}',${ownerHistory},$,$,${site},(${building}));`);
  lines.push(`${nextId()}=IFCRELAGGREGATES('${ifcGuid()}',${ownerHistory},$,$,${building},(${storeyEntities.join(',')}));`);

  // Uniformat classification root. Individual classification references are
  // created lazily only for codes that are actually used by exported elements.
  const uniformatClassification = nextId();
  lines.push(`${uniformatClassification}=IFCCLASSIFICATION('ASTM',$,$,'Uniformat II',$,$,$);`);

  // Surface style cache (one IfcSurfaceStyle per unique color)
  const styleCache = new Map();
  function getOrCreateStyle(color, transparency = null) {
    if (!color) return null;
    const tKey = transparency == null ? 'opaque' : Number(transparency).toFixed(3);
    const key = `${color.r.toFixed(3)},${color.g.toFixed(3)},${color.b.toFixed(3)},${tKey}`;
    if (styleCache.has(key)) return styleCache.get(key);

    const colourRgb = nextId();
    lines.push(`${colourRgb}=IFCCOLOURRGB($,${color.r.toFixed(4)},${color.g.toFixed(4)},${color.b.toFixed(4)});`);
    const surfShading = nextId();
    const transparencyValue = transparency == null ? '$' : Number(transparency).toFixed(4);
    lines.push(`${surfShading}=IFCSURFACESTYLESHADING(${colourRgb},${transparencyValue});`);
    const surfStyle = nextId();
    lines.push(`${surfStyle}=IFCSURFACESTYLE($,.BOTH.,(${surfShading}));`);
    const presStyle = nextId();
    lines.push(`${presStyle}=IFCPRESENTATIONSTYLEASSIGNMENT((${surfStyle}));`);

    const ref = { presStyle };
    styleCache.set(key, ref);
    return ref;
  }

  const materialCache = new Map();
  const materialGroups = new Map();

  function materialNameFromSource(mesh) {
    const raw = String(mesh.materialName || '').trim();

    if (!raw || isDefaultMaterialName(raw)) return null;

    return raw
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 120);
  }

  function inferredMaterialName(mesh) {
    const text = searchableText(mesh);

    if (/(glass|glazing|vitre|vitrage|verre)/i.test(text) || mesh.classification === 'window') {
      return 'Glass';
    }

    if (/(wood|timber|bois|chene|chêne|pin|sapin|porte)/i.test(text) || mesh.classification === 'door') {
      return 'Wood';
    }

    if (/(steel|metal|acier|fer|alu|aluminium|inox|ipe|hea|heb|ipn)/i.test(text)) {
      return 'Metal';
    }

    if (/(concrete|beton|béton|cement|ciment)/i.test(text)) {
      return 'Concrete';
    }

    if (/(brick|brique|masonry|maconnerie|maçonnerie|stone|pierre)/i.test(text)) {
      return 'Masonry';
    }

    if (/(tile|tuile|ardoise|zinc|roof|toit|toiture|couverture)/i.test(text) || mesh.classification === 'roof') {
      return 'Roof Material';
    }

    if (mesh.classification === 'wall') return mesh.isExternal ? 'Exterior Wall Material' : 'Interior Wall Material';
    if (mesh.classification === 'slab') return 'Slab Material';
    if (mesh.classification === 'beam') return 'Beam Material';
    if (mesh.classification === 'column') return 'Column Material';
    if (mesh.classification === 'stair') return 'Stair Material';

    return 'Generic Material';
  }

  function materialNameForMesh(mesh) {
    return materialNameFromSource(mesh) || inferredMaterialName(mesh);
  }

  function getOrCreateMaterial(materialName) {
    const safeName = materialName || 'Generic Material';

    if (materialCache.has(safeName)) {
      return materialCache.get(safeName);
    }

    const materialId = nextId();
    lines.push(`${materialId}=IFCMATERIAL('${escapeIFCString(safeName)}',$,$);`);
    materialCache.set(safeName, materialId);

    return materialId;
  }

  function queueMaterialAssociation(mesh, elementId) {
    const materialName = materialNameForMesh(mesh);
    const materialId = getOrCreateMaterial(materialName);

    if (!materialGroups.has(materialId)) {
      materialGroups.set(materialId, {
        materialName,
        elementIds: []
      });
    }

    materialGroups.get(materialId).elementIds.push(elementId);
  }

  function addMaterialAssociations() {
    const counts = {};

    for (const [materialId, group] of materialGroups.entries()) {
      if (group.elementIds.length === 0) continue;

      lines.push(`${nextId()}=IFCRELASSOCIATESMATERIAL('${ifcGuid()}',${ownerHistory},'Material ${escapeIFCString(group.materialName)}',$,(${group.elementIds.join(',')}),${materialId});`);
      counts[group.materialName] = (counts[group.materialName] || 0) + group.elementIds.length;
    }

    return counts;
  }

  const PRESENTATION_LAYER_MAP = {
    wall:   { name: 'A-WALL',   description: 'Walls' },
    slab:   { name: 'A-SLAB',   description: 'Slabs and floors' },
    door:   { name: 'A-DOOR',   description: 'Doors' },
    window: { name: 'A-WINDOW', description: 'Windows and glazing' },
    roof:   { name: 'A-ROOF',   description: 'Roofs' },
    stair:  { name: 'A-STAIR',  description: 'Stairs' },
    space:  { name: 'A-SPACE',  description: 'Approximate spaces' },
    beam:   { name: 'S-BEAM',   description: 'Structural beams' },
    column: { name: 'S-COLUMN', description: 'Structural columns' },
    proxy:  { name: 'Z-PROXY',  description: 'Unclassified proxy geometry' }
  };

  const presentationLayerGroups = new Map();

  function queuePresentationLayer(mesh, layeredItemId) {
    const info = PRESENTATION_LAYER_MAP[mesh.classification] || PRESENTATION_LAYER_MAP.proxy;

    if (!presentationLayerGroups.has(info.name)) {
      presentationLayerGroups.set(info.name, {
        info,
        itemIds: []
      });
    }

    presentationLayerGroups.get(info.name).itemIds.push(layeredItemId);
  }

  function addPresentationLayerAssignments() {
    const counts = {};

    for (const group of presentationLayerGroups.values()) {
      if (group.itemIds.length === 0) continue;

      // Assign the layer to the shape representation. This keeps products
      // semantically classified while still allowing IFC viewers to toggle
      // visibility by category/layer.
      lines.push(`${nextId()}=IFCPRESENTATIONLAYERASSIGNMENT('${escapeIFCString(group.info.name)}','${escapeIFCString(group.info.description)}',(${group.itemIds.join(',')}),'${escapeIFCString(group.info.name)}');`);
      counts[group.info.name] = group.itemIds.length;
    }

    return counts;
  }

  function addPropertySingleValue(name, typedValue) {
    const prop = nextId();
    lines.push(`${prop}=IFCPROPERTYSINGLEVALUE('${escapeIFCString(name)}',$,${typedValue},$);`);
    return prop;
  }

  function validMeasure(value) {
    return Number.isFinite(value) && value > 0;
  }

  function formatMeasure(value) {
    return Number(value).toFixed(4);
  }

  function addQuantityLength(name, value) {
    if (!validMeasure(value)) return null;
    const q = nextId();
    lines.push(`${q}=IFCQUANTITYLENGTH('${escapeIFCString(name)}',$,$,${formatMeasure(value)},$);`);
    return q;
  }

  function addQuantityArea(name, value) {
    if (!validMeasure(value)) return null;
    const q = nextId();
    lines.push(`${q}=IFCQUANTITYAREA('${escapeIFCString(name)}',$,$,${formatMeasure(value)},$);`);
    return q;
  }

  function addQuantityVolume(name, value) {
    if (!validMeasure(value)) return null;
    const q = nextId();
    lines.push(`${q}=IFCQUANTITYVOLUME('${escapeIFCString(name)}',$,$,${formatMeasure(value)},$);`);
    return q;
  }

  function addElementQuantity(elementId, qtoName, quantityIds) {
    const qs = quantityIds.filter(Boolean);
    if (qs.length === 0) return false;

    const qto = nextId();
    lines.push(`${qto}=IFCELEMENTQUANTITY('${ifcGuid()}',${ownerHistory},'${escapeIFCString(qtoName)}',$,$,(${qs.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${elementId}),${qto});`);
    return true;
  }

  function approximateElementQuantities(mesh, elementId) {
    const s = bboxStats(mesh);
    const f = triangleFaceAnalysis(mesh);

    const length = s.horizontal;
    const width = s.minHoriz;
    const height = s.sizeY;
    const planArea = s.areaXZ;
    const bboxVolume = s.sizeX * s.sizeY * s.sizeZ;
    const perimeter = 2 * (s.sizeX + s.sizeZ);
    const crossSectionArea = Math.max(0, width * height);

    if (mesh.classification === 'wall') {
      return addElementQuantity(elementId, 'Qto_WallBaseQuantities', [
        addQuantityLength('Length', length),
        addQuantityLength('Width', width),
        addQuantityLength('Height', height),
        addQuantityArea('GrossSideArea', length * height),
        addQuantityArea('NetSideArea', length * height),
        addQuantityVolume('GrossVolume', length * width * height)
      ]);
    }

    if (mesh.classification === 'slab') {
      return addElementQuantity(elementId, 'Qto_SlabBaseQuantities', [
        addQuantityLength('Thickness', height),
        addQuantityArea('GrossArea', planArea),
        addQuantityArea('NetArea', planArea),
        addQuantityLength('Perimeter', perimeter),
        addQuantityVolume('GrossVolume', planArea * height)
      ]);
    }

    if (mesh.classification === 'beam') {
      return addElementQuantity(elementId, 'Qto_BeamBaseQuantities', [
        addQuantityLength('Length', length),
        addQuantityLength('Width', width),
        addQuantityLength('Height', height),
        addQuantityArea('CrossSectionArea', crossSectionArea),
        addQuantityArea('GrossSurfaceArea', f.totalArea),
        addQuantityVolume('GrossVolume', length * width * height)
      ]);
    }

    if (mesh.classification === 'column') {
      return addElementQuantity(elementId, 'Qto_ColumnBaseQuantities', [
        addQuantityLength('Height', height),
        addQuantityLength('Width', s.sizeX),
        addQuantityLength('Depth', s.sizeZ),
        addQuantityArea('CrossSectionArea', planArea),
        addQuantityArea('GrossSurfaceArea', f.totalArea),
        addQuantityVolume('GrossVolume', bboxVolume)
      ]);
    }

    if (mesh.classification === 'roof') {
      return addElementQuantity(elementId, 'Qto_RoofBaseQuantities', [
        addQuantityArea('GrossArea', f.totalArea),
        addQuantityArea('ProjectedArea', planArea),
        addQuantityVolume('GrossVolume', bboxVolume)
      ]);
    }

    if (mesh.classification === 'door') {
      return addElementQuantity(elementId, 'Qto_DoorBaseQuantities', [
        addQuantityLength('Height', height),
        addQuantityLength('Width', length),
        addQuantityArea('Area', height * length)
      ]);
    }

    if (mesh.classification === 'window') {
      return addElementQuantity(elementId, 'Qto_WindowBaseQuantities', [
        addQuantityLength('Height', height),
        addQuantityLength('Width', length),
        addQuantityArea('Area', height * length)
      ]);
    }

    if (mesh.classification === 'stair') {
      return addElementQuantity(elementId, 'Qto_StairBaseQuantities', [
        addQuantityLength('Height', height),
        addQuantityLength('Length', length),
        addQuantityLength('Width', width),
        addQuantityArea('GrossSurfaceArea', f.totalArea),
        addQuantityVolume('GrossVolume', bboxVolume)
      ]);
    }

    return false;
  }

  function addWallCommonPset(wallElementId, mesh) {
    const props = [
      addPropertySingleValue('Reference', `IFCIDENTIFIER('')`),
      addPropertySingleValue('IsExternal', `IFCBOOLEAN(${mesh.isExternal ? '.T.' : '.F.'})`),
      addPropertySingleValue('LoadBearing', `IFCBOOLEAN(.F.)`),
      addPropertySingleValue('ExtendToStructure', `IFCBOOLEAN(.F.)`)
    ];

    const pset = nextId();
    lines.push(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory},'Pset_WallCommon',$,(${props.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${wallElementId}),${pset});`);
  }


  function addBeamCommonPset(beamElementId, mesh) {
    const props = [
      addPropertySingleValue('Reference', `IFCIDENTIFIER('')`),
      addPropertySingleValue('IsExternal', `IFCBOOLEAN(.F.)`),
      addPropertySingleValue('LoadBearing', `IFCBOOLEAN(.F.)`)
    ];

    const pset = nextId();
    lines.push(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory},'Pset_BeamCommon',$,(${props.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${beamElementId}),${pset});`);
  }


  function addColumnCommonPset(columnElementId, mesh) {
    const props = [
      addPropertySingleValue('Reference', `IFCIDENTIFIER('')`),
      addPropertySingleValue('IsExternal', `IFCBOOLEAN(.F.)`),
      addPropertySingleValue('LoadBearing', `IFCBOOLEAN(.F.)`)
    ];

    const pset = nextId();
    lines.push(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory},'Pset_ColumnCommon',$,(${props.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${columnElementId}),${pset});`);
  }

  function addStairCommonPset(stairElementId, mesh) {
    const props = [
      addPropertySingleValue('Reference', `IFCIDENTIFIER('')`),
      addPropertySingleValue('IsExternal', `IFCBOOLEAN(.F.)`)
    ];

    const pset = nextId();
    lines.push(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory},'Pset_StairCommon',$,(${props.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${stairElementId}),${pset});`);
  }

  function addRoofCommonPset(roofElementId, mesh) {
    const props = [
      addPropertySingleValue('Reference', `IFCIDENTIFIER('')`),
      addPropertySingleValue('IsExternal', `IFCBOOLEAN(.T.)`),
      addPropertySingleValue('LoadBearing', `IFCBOOLEAN(.F.)`)
    ];

    const pset = nextId();
    lines.push(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory},'Pset_RoofCommon',$,(${props.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${roofElementId}),${pset});`);
  }

  function addSpaceCommonPset(spaceElementId) {
    const props = [
      addPropertySingleValue('Reference', `IFCIDENTIFIER('')`),
      addPropertySingleValue('IsExternal', `IFCBOOLEAN(.F.)`),
      addPropertySingleValue('OccupancyType', `IFCLABEL('Approximate storey space')`)
    ];

    const pset = nextId();
    lines.push(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory},'Pset_SpaceCommon',$,(${props.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${spaceElementId}),${pset});`);
  }


  const UNIFORMAT_MAP = {
    exterior_wall: { code: 'B2010', name: 'Exterior Walls' },
    interior_wall: { code: 'C1010', name: 'Partitions' },
    floor_construction: { code: 'B1010', name: 'Floor Construction' },
    roof_construction: { code: 'B1020', name: 'Roof Construction' },
    roof_coverings: { code: 'B3010', name: 'Roof Coverings' },
    exterior_windows: { code: 'B2020', name: 'Exterior Windows' },
    exterior_doors: { code: 'B2030', name: 'Exterior Doors' },
    interior_doors: { code: 'C1020', name: 'Interior Doors' },
    stair_construction: { code: 'C2010', name: 'Stair Construction' }
  };

  function hostWallIsExternal(mesh) {
    if (mesh.hostWall && mesh.hostWall.classification === 'wall') {
      return mesh.hostWall.isExternal === true;
    }

    if (mesh.hostWallName) {
      const host = meshes.find(m =>
        m.classification === 'wall' &&
        m.name === mesh.hostWallName
      );
      if (host) return host.isExternal === true;
    }

    return null;
  }

  const buildingTopY = meshes.length > 0
    ? Math.max(...meshes.map(m => bboxStats(m).maxY))
    : 0;

  const buildingBottomY = meshes.length > 0
    ? Math.min(...meshes.map(m => bboxStats(m).minY))
    : 0;

  const buildingHeight = Math.max(0.001, buildingTopY - buildingBottomY);
  const roofBeamTopTolerance = Math.min(1.5, Math.max(0.45, buildingHeight * 0.10));
  const roofZoneDepth = Math.min(2.4, Math.max(0.75, buildingHeight * 0.18));
  const roofMeshes = meshes.filter(m => m.classification === 'roof');

  function isRoofConstructionBeam(mesh) {
    if (mesh.classification !== 'beam') return false;

    const s = bboxStats(mesh);

    if (hasRoofStructureHint(mesh)) {
      mesh.uniformatReason = 'roof_structure_name_hint';
      return true;
    }

    const nearAbsoluteTop = s.maxY >= buildingTopY - roofBeamTopTolerance;
    const inUpperRoofZone = s.centerY >= buildingTopY - roofZoneDepth;
    const onTopStorey = storeys.length > 0 && mesh.storeyIndex >= storeys.length - 1;

    const closeToRoofMesh = roofMeshes.some(roof => {
      const r = bboxStats(roof);
      const verticalNear =
        s.maxY >= r.minY - 0.85 &&
        s.minY <= r.maxY + 0.85;

      const planOverlap =
        bboxOverlapsXZ(mesh, roof, 0.35) &&
        bboxOverlapRatioXZ(mesh, roof, 0.35) >= 0.03;

      return verticalNear && planOverlap;
    });

    if (closeToRoofMesh) {
      mesh.uniformatReason = 'near_roof_mesh';
      return true;
    }

    if (nearAbsoluteTop || (onTopStorey && inUpperRoofZone)) {
      mesh.uniformatReason = nearAbsoluteTop ? 'near_building_top' : 'top_storey_roof_zone';
      return true;
    }

    mesh.uniformatReason = 'floor_framing_default';
    return false;
  }

  function uniformatInfoForMesh(mesh) {
    if (mesh.classification === 'wall') {
      return mesh.isExternal ? UNIFORMAT_MAP.exterior_wall : UNIFORMAT_MAP.interior_wall;
    }

    if (mesh.classification === 'beam') {
      return isRoofConstructionBeam(mesh)
        ? UNIFORMAT_MAP.roof_construction
        : UNIFORMAT_MAP.floor_construction;
    }

    if (mesh.classification === 'slab' || mesh.classification === 'column') {
      return UNIFORMAT_MAP.floor_construction;
    }

    if (mesh.classification === 'roof') {
      return UNIFORMAT_MAP.roof_coverings;
    }

    if (mesh.classification === 'stair') {
      return UNIFORMAT_MAP.stair_construction;
    }

    if (mesh.classification === 'window') {
      const externalHost = hostWallIsExternal(mesh);
      return externalHost === false ? UNIFORMAT_MAP.interior_wall : UNIFORMAT_MAP.exterior_windows;
    }

    if (mesh.classification === 'door') {
      const externalHost = hostWallIsExternal(mesh);
      return externalHost === true ? UNIFORMAT_MAP.exterior_doors : UNIFORMAT_MAP.interior_doors;
    }

    return null;
  }

  const uniformatReferenceCache = new Map();
  const uniformatGroups = new Map();

  function getOrCreateUniformatReference(info) {
    if (uniformatReferenceCache.has(info.code)) {
      return uniformatReferenceCache.get(info.code);
    }

    const ref = nextId();
    lines.push(`${ref}=IFCCLASSIFICATIONREFERENCE($,'${escapeIFCString(info.code)}','${escapeIFCString(info.name)}',${uniformatClassification},$,$);`);
    uniformatReferenceCache.set(info.code, ref);
    return ref;
  }

  function queueUniformatAssociation(mesh, elementId) {
    const info = uniformatInfoForMesh(mesh);
    if (!info) return;

    if (!uniformatGroups.has(info.code)) {
      uniformatGroups.set(info.code, {
        info,
        elementIds: []
      });
    }

    uniformatGroups.get(info.code).elementIds.push(elementId);
  }

  function addUniformatAssociations() {
    const counts = {};

    for (const group of uniformatGroups.values()) {
      if (group.elementIds.length === 0) continue;

      const ref = getOrCreateUniformatReference(group.info);
      lines.push(`${nextId()}=IFCRELASSOCIATESCLASSIFICATION('${ifcGuid()}',${ownerHistory},'Uniformat ${escapeIFCString(group.info.code)}',$,(${group.elementIds.join(',')}),${ref});`);
      counts[group.info.code] = {
        name: group.info.name,
        count: group.elementIds.length
      };
    }

    return counts;
  }

  function boundsFromMeshes(sourceMeshes) {
    if (!sourceMeshes || sourceMeshes.length === 0) return null;

    return {
      minX: Math.min(...sourceMeshes.map(m => m.bbox.min[0])),
      maxX: Math.max(...sourceMeshes.map(m => m.bbox.max[0])),
      minY: Math.min(...sourceMeshes.map(m => m.bbox.min[1])),
      maxY: Math.max(...sourceMeshes.map(m => m.bbox.max[1])),
      minZ: Math.min(...sourceMeshes.map(m => m.bbox.min[2])),
      maxZ: Math.max(...sourceMeshes.map(m => m.bbox.max[2]))
    };
  }

  function estimateSpaceHeight(storeyIndex, storeyMeshes) {
    const current = storeys[storeyIndex];
    const next = storeys[storeyIndex + 1];
    const previous = storeys[storeyIndex - 1];

    if (next) {
      const delta = next.elevation - current.elevation;
      if (delta >= 1.8 && delta <= 6.0) return delta;
    }

    if (previous) {
      const delta = current.elevation - previous.elevation;
      if (delta >= 1.8 && delta <= 6.0) return delta;
    }

    const bounds = boundsFromMeshes(storeyMeshes);
    if (bounds) {
      const detectedHeight = bounds.maxY - current.elevation;
      if (detectedHeight >= 1.8 && detectedHeight <= 5.0) {
        return detectedHeight;
      }
    }

    return 2.8;
  }

  function makeBoxTriangulatedFaceSet(bounds) {
    const points = [
      [bounds.minX, bounds.minY, bounds.minZ],
      [bounds.maxX, bounds.minY, bounds.minZ],
      [bounds.maxX, bounds.minY, bounds.maxZ],
      [bounds.minX, bounds.minY, bounds.maxZ],
      [bounds.minX, bounds.maxY, bounds.minZ],
      [bounds.maxX, bounds.maxY, bounds.minZ],
      [bounds.maxX, bounds.maxY, bounds.maxZ],
      [bounds.minX, bounds.maxY, bounds.maxZ]
    ];

    // glTF is Y-up. IFC is exported as Z-up, using the same convention as the
    // converted elements: IFC (X, Y, Z) = glTF (X, -Z, Y).
    const coords = points.map(([x, y, z]) => `(${x.toFixed(6)},${(-z).toFixed(6)},${y.toFixed(6)})`);

    const faces = [
      [1, 2, 3], [1, 3, 4], // bottom
      [5, 7, 6], [5, 8, 7], // top
      [1, 5, 6], [1, 6, 2],
      [2, 6, 7], [2, 7, 3],
      [3, 7, 8], [3, 8, 4],
      [4, 8, 5], [4, 5, 1]
    ];

    const pointList = nextId();
    lines.push(`${pointList}=IFCCARTESIANPOINTLIST3D((${coords.join(',')}));`);

    const faceSet = nextId();
    lines.push(`${faceSet}=IFCTRIANGULATEDFACESET(${pointList},$,$,(${faces.map(f => `(${f.join(',')})`).join(',')}),$);`);

    return faceSet;
  }

  function makeVariableTopBoxTriangulatedFaceSet(bounds, topYByCorner) {
    const bottomY = bounds.minY;
    const top = {
      p0: Number.isFinite(topYByCorner?.p0) ? topYByCorner.p0 : bounds.maxY,
      p1: Number.isFinite(topYByCorner?.p1) ? topYByCorner.p1 : bounds.maxY,
      p2: Number.isFinite(topYByCorner?.p2) ? topYByCorner.p2 : bounds.maxY,
      p3: Number.isFinite(topYByCorner?.p3) ? topYByCorner.p3 : bounds.maxY
    };

    const points = [
      [bounds.minX, bottomY, bounds.minZ],
      [bounds.maxX, bottomY, bounds.minZ],
      [bounds.maxX, bottomY, bounds.maxZ],
      [bounds.minX, bottomY, bounds.maxZ],
      [bounds.minX, top.p0, bounds.minZ],
      [bounds.maxX, top.p1, bounds.minZ],
      [bounds.maxX, top.p2, bounds.maxZ],
      [bounds.minX, top.p3, bounds.maxZ]
    ];

    const coords = points.map(([x, y, z]) => `(${x.toFixed(6)},${(-z).toFixed(6)},${y.toFixed(6)})`);

    const faces = [
      [1, 2, 3], [1, 3, 4],
      [5, 7, 6], [5, 8, 7],
      [1, 5, 6], [1, 6, 2],
      [2, 6, 7], [2, 7, 3],
      [3, 7, 8], [3, 8, 4],
      [4, 8, 5], [4, 5, 1]
    ];

    const pointList = nextId();
    lines.push(`${pointList}=IFCCARTESIANPOINTLIST3D((${coords.join(',')}));`);

    const faceSet = nextId();
    lines.push(`${faceSet}=IFCTRIANGULATEDFACESET(${pointList},$,$,(${faces.map(f => `(${f.join(',')})`).join(',')}),$);`);

    return faceSet;
  }

  function pointInTriangle2D(px, pz, a, b, c, tolerance = 1e-8) {
    const v0x = c[0] - a[0];
    const v0z = c[2] - a[2];
    const v1x = b[0] - a[0];
    const v1z = b[2] - a[2];
    const v2x = px - a[0];
    const v2z = pz - a[2];

    const dot00 = v0x * v0x + v0z * v0z;
    const dot01 = v0x * v1x + v0z * v1z;
    const dot02 = v0x * v2x + v0z * v2z;
    const dot11 = v1x * v1x + v1z * v1z;
    const dot12 = v1x * v2x + v1z * v2z;

    const denom = dot00 * dot11 - dot01 * dot01;
    if (Math.abs(denom) < tolerance) return null;

    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    if (u >= -0.001 && v >= -0.001 && u + v <= 1.001) {
      return { u, v, w: 1 - u - v };
    }

    return null;
  }

  function interpolateTriangleY(px, pz, a, b, c) {
    const bary = pointInTriangle2D(px, pz, a, b, c);
    if (!bary) return null;

    return bary.w * a[1] + bary.v * b[1] + bary.u * c[1];
  }

  function roofHeightAtPoint(x, z, minY, fallbackMaxY) {
    let best = null;

    for (const roof of meshes) {
      if (roof.classification !== 'roof') continue;
      if (roof.bbox.max[1] < minY + 0.25) continue;
      if (roof.bbox.min[1] > fallbackMaxY + 3.0) continue;
      if (x < roof.bbox.min[0] - 0.25 || x > roof.bbox.max[0] + 0.25) continue;
      if (z < roof.bbox.min[2] - 0.25 || z > roof.bbox.max[2] + 0.25) continue;

      for (let i = 0; i < roof.indices.length; i += 3) {
        const ia = roof.indices[i] * 3;
        const ib = roof.indices[i + 1] * 3;
        const ic = roof.indices[i + 2] * 3;

        const a = [roof.positions[ia], roof.positions[ia + 1], roof.positions[ia + 2]];
        const b = [roof.positions[ib], roof.positions[ib + 1], roof.positions[ib + 2]];
        const c = [roof.positions[ic], roof.positions[ic + 1], roof.positions[ic + 2]];

        const y = interpolateTriangleY(x, z, a, b, c);
        if (!Number.isFinite(y)) continue;
        if (y < minY + 1.20) continue;
        if (y > fallbackMaxY + 2.5) continue;

        if (best == null || y < best) {
          best = y;
        }
      }
    }

    return best;
  }

  function slopedBeamSlopeInfo(mesh) {
    if (mesh.classification !== 'beam') return null;

    const s = bboxStats(mesh);
    const useZLongAxis = s.sizeZ >= s.sizeX && s.sizeZ >= 0.85 && s.sizeY >= 0.15;
    const useXLongAxis = s.sizeX > s.sizeZ && s.sizeX >= 0.85 && s.sizeY >= 0.15;

    if (!useZLongAxis && !useXLongAxis) return null;

    const samples = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      samples.push({
        h: useZLongAxis ? mesh.positions[i + 2] : mesh.positions[i],
        side: useZLongAxis ? mesh.positions[i] : mesh.positions[i + 2],
        y: mesh.positions[i + 1]
      });
    }

    if (samples.length < 2) return null;

    const n = samples.length;
    const meanH = samples.reduce((sum, p) => sum + p.h, 0) / n;
    const meanY = samples.reduce((sum, p) => sum + p.y, 0) / n;
    const denom = samples.reduce((sum, p) => sum + Math.pow(p.h - meanH, 2), 0);

    if (denom <= 1e-8) return null;

    const slope = samples.reduce((sum, p) => sum + (p.h - meanH) * (p.y - meanY), 0) / denom;
    const intercept = meanY - slope * meanH;

    const hValues = samples.map(p => p.h);
    const yValues = samples.map(p => p.y);
    const sideValues = samples.map(p => p.side);

    const minH = Math.min(...hValues);
    const maxH = Math.max(...hValues);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const sideCenter = sideValues.reduce((sum, value) => sum + value, 0) / sideValues.length;
    const sideSpan = Math.max(...sideValues) - Math.min(...sideValues);

    const hSpan = maxH - minH;
    const ySpan = maxY - minY;

    if (hSpan < 0.85 || ySpan < 0.12 || Math.abs(slope) < 0.025) return null;

    return {
      useZLongAxis,
      minH,
      maxH,
      slope,
      intercept,
      sideCenter,
      sideSpan,
      hSpan,
      ySpan
    };
  }

  function roofBeamHeightAtPoint(x, z, bounds, fallbackMaxY) {
    let best = null;

    for (const beam of meshes) {
      if (beam.classification !== 'beam') continue;

      // Prefer beams that are already identified as roof construction. This
      // lets chevrons / pannes / roof beams drive the attic space slope instead
      // of relying on a broad roof mesh whose triangle orientation can be
      // ambiguous.
      if (typeof isRoofConstructionBeam === 'function' && !isRoofConstructionBeam(beam) && !hasRoofStructureHint(beam)) {
        continue;
      }

      if (beam.bbox.max[1] < bounds.minY + 0.45) continue;
      if (beam.bbox.min[1] > fallbackMaxY + 3.0) continue;
      if (!bboxOverlapsXZ(beam, { bbox: { min: [bounds.minX, bounds.minY, bounds.minZ], max: [bounds.maxX, fallbackMaxY, bounds.maxZ] } }, 1.25)) {
        continue;
      }

      const info = slopedBeamSlopeInfo(beam);
      if (!info) continue;

      const h = info.useZLongAxis ? z : x;
      const side = info.useZLongAxis ? x : z;

      const extension = 0.85;
      if (h < info.minH - extension || h > info.maxH + extension) continue;

      const sideDistance = Math.abs(side - info.sideCenter);
      const sideTolerance = Math.max(1.20, info.sideSpan + 0.90);
      if (sideDistance > sideTolerance) continue;

      const y = info.slope * h + info.intercept;
      if (!Number.isFinite(y)) continue;
      if (y < bounds.minY + 1.20) continue;
      if (y > fallbackMaxY + 2.5) continue;

      const hPenalty = h < info.minH || h > info.maxH ? 0.45 : 0;
      const score = sideDistance + hPenalty;

      if (!best || score < best.score) {
        best = {
          y,
          score,
          beam
        };
      }
    }

    return best;
  }

  function variableTopFromRoof(bounds, fallbackMaxY) {
    const clearance = 0.12;
    let usedBeam = false;
    let usedRoof = false;

    const sample = (x, z) => {
      const beamHit = roofBeamHeightAtPoint(x, z, bounds, fallbackMaxY);
      if (beamHit && Number.isFinite(beamHit.y)) {
        usedBeam = true;
        return Math.max(bounds.minY + 1.35, beamHit.y - clearance);
      }

      const roofY = roofHeightAtPoint(x, z, bounds.minY, fallbackMaxY);
      if (Number.isFinite(roofY)) {
        usedRoof = true;
        return Math.max(bounds.minY + 1.35, roofY - clearance);
      }

      return fallbackMaxY;
    };

    const top = {
      p0: sample(bounds.minX, bounds.minZ),
      p1: sample(bounds.maxX, bounds.minZ),
      p2: sample(bounds.maxX, bounds.maxZ),
      p3: sample(bounds.minX, bounds.maxZ)
    };

    const values = Object.values(top);
    const usable = values.some(v => Math.abs(v - fallbackMaxY) > 0.08);
    const minTop = Math.min(...values);

    if (!usable || minTop <= bounds.minY + 1.20) {
      return null;
    }

    top.source = usedBeam ? 'beam' : (usedRoof ? 'roof' : 'fallback');

    return top;
  }

  function rectArea(rect) {
    return Math.max(0, rect.maxX - rect.minX) * Math.max(0, rect.maxZ - rect.minZ);
  }

  function rectIntersectionArea(a, b, tolerance = 0) {
    const minX = Math.max(a.minX, b.minX) - tolerance;
    const maxX = Math.min(a.maxX, b.maxX) + tolerance;
    const minZ = Math.max(a.minZ, b.minZ) - tolerance;
    const maxZ = Math.min(a.maxZ, b.maxZ) + tolerance;

    return Math.max(0, maxX - minX) * Math.max(0, maxZ - minZ);
  }

  function rectsTouchOrOverlap(a, b, tolerance = 0.18) {
    return !(
      a.maxX + tolerance < b.minX ||
      b.maxX + tolerance < a.minX ||
      a.maxZ + tolerance < b.minZ ||
      b.maxZ + tolerance < a.minZ
    );
  }

  function median(values) {
    const arr = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (arr.length === 0) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function normalizedRectKey(rect, grid = 0.05) {
    return [
      Math.round(rect.minX / grid),
      Math.round(rect.maxX / grid),
      Math.round(rect.minZ / grid),
      Math.round(rect.maxZ / grid)
    ].join(':');
  }

  function slabRectFromMesh(mesh) {
    const widthX = mesh.bbox.max[0] - mesh.bbox.min[0];
    const depthZ = mesh.bbox.max[2] - mesh.bbox.min[2];

    if (widthX < 0.35 || depthZ < 0.35) return null;

    const area = widthX * depthZ;

    return {
      mesh,
      minX: mesh.bbox.min[0],
      maxX: mesh.bbox.max[0],
      minZ: mesh.bbox.min[2],
      maxZ: mesh.bbox.max[2],
      minY: mesh.bbox.min[1],
      maxY: mesh.bbox.max[1],
      centerX: (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2,
      centerZ: (mesh.bbox.min[2] + mesh.bbox.max[2]) / 2,
      widthX,
      depthZ,
      area
    };
  }

  function slabRectsForStorey(storeyIndex) {
    const storey = storeys[storeyIndex];

    const slabs = meshes
      .filter(m => m.storeyIndex === storeyIndex && m.classification === 'slab')
      .map(slabRectFromMesh)
      .filter(Boolean);

    if (slabs.length === 0) return [];

    // Prefer slabs whose top is close to the detected storey level. This avoids
    // creating spaces from ceiling/roof slabs that may be assigned to the same
    // storey in imperfect source models.
    const nearFloor = slabs.filter(rect => Math.abs(rect.maxY - storey.elevation) <= 0.80);
    const candidates = nearFloor.length > 0 ? nearFloor : slabs;

    // Remove near-duplicate slab rectangles, keeping the larger footprint.
    const sorted = [...candidates].sort((a, b) => rectArea(b) - rectArea(a));
    const kept = [];

    for (const rect of sorted) {
      const duplicate = kept.some(existing => {
        const overlap = rectIntersectionArea(rect, existing, 0.03);
        const ratio = overlap / Math.max(0.0001, Math.min(rectArea(rect), rectArea(existing)));
        return ratio > 0.88;
      });

      if (!duplicate) kept.push(rect);
    }

    if (kept.length === 0) return [];

    // Filter parasitic slab fragments with adaptive thresholds. Small landings
    // can still be kept if they are explicitly stair-like, but tiny isolated
    // fragments should not create spaces.
    const maxArea = Math.max(...kept.map(r => r.area));

    // Stronger filter against tiny slab fragments:
    // - normal spaces should not be generated from tiny isolated slabs;
    // - small stair landings / balcony / terrace pieces may still be kept only
    //   if their naming clearly indicates that intent;
    // - tiny pieces that merely touch a larger slab are no longer allowed to
    //   create their own space. They are useful as geometry, but too noisy as
    //   IfcSpace seeds.
    const absoluteMinArea = 2.50;
    const relativeMinArea = Math.max(absoluteMinArea, maxArea * 0.025);

    const filtered = kept.filter(rect => {
      const text = searchableText(rect.mesh);
      const stairLike = hasStairHint(rect.mesh) || /(palier|landing|marche|stair|escalier)/i.test(text);
      const terraceLike = /(terrace|terrasse|balcony|balcon|loggia|deck|patio)/i.test(text);

      if (rect.area >= relativeMinArea) return true;
      if ((stairLike || terraceLike) && rect.area >= 1.20) return true;

      return false;
    });

    return filtered;
  }

  function clusterSlabRects(rects) {
    const clusters = [];

    for (const rect of rects) {
      const touched = [];

      for (let i = 0; i < clusters.length; i++) {
        if (clusters[i].some(existing => rectsTouchOrOverlap(existing, rect, 0.22))) {
          touched.push(i);
        }
      }

      if (touched.length === 0) {
        clusters.push([rect]);
        continue;
      }

      const merged = [rect];
      for (const idx of touched.reverse()) {
        merged.push(...clusters[idx]);
        clusters.splice(idx, 1);
      }
      clusters.push(merged);
    }

    return clusters;
  }

  function boundsFromRects(rects) {
    if (!rects || rects.length === 0) return null;

    return {
      minX: Math.min(...rects.map(r => r.minX)),
      maxX: Math.max(...rects.map(r => r.maxX)),
      minY: Math.min(...rects.map(r => r.minY)),
      maxY: Math.max(...rects.map(r => r.maxY)),
      minZ: Math.min(...rects.map(r => r.minZ)),
      maxZ: Math.max(...rects.map(r => r.maxZ))
    };
  }

  function mergeRectsIntoCells(rects, tolerance = 0.10) {
    if (!rects || rects.length === 0) return [];

    // Grid-merge the union of adjacent slab rectangles. This avoids rendering a
    // separate box per slab when several slabs form a continuous floor area.
    const xs = [];
    const zs = [];

    for (const r of rects) {
      xs.push(r.minX, r.maxX);
      zs.push(r.minZ, r.maxZ);
    }

    xs.sort((a, b) => a - b);
    zs.sort((a, b) => a - b);

    function compact(values) {
      const out = [];
      for (const value of values) {
        if (out.length === 0 || Math.abs(value - out[out.length - 1]) > tolerance) {
          out.push(value);
        } else {
          out[out.length - 1] = (out[out.length - 1] + value) / 2;
        }
      }
      return out;
    }

    const ux = compact(xs);
    const uz = compact(zs);
    const cells = [];

    for (let xi = 0; xi < ux.length - 1; xi++) {
      for (let zi = 0; zi < uz.length - 1; zi++) {
        const cell = {
          minX: ux[xi],
          maxX: ux[xi + 1],
          minZ: uz[zi],
          maxZ: uz[zi + 1]
        };

        const area = rectArea(cell);
        if (area < 0.05) continue;

        const covered = rects.some(rect => {
          const overlap = rectIntersectionArea(cell, rect, 0.015);
          return overlap / Math.max(0.0001, area) >= 0.65;
        });

        if (covered) {
          cells.push({
            ...cell,
            area
          });
        }
      }
    }

    // Merge horizontally aligned cells into larger rectangles.
    let merged = cells;
    let changed = true;

    while (changed) {
      changed = false;

      outer:
      for (let i = 0; i < merged.length; i++) {
        for (let j = i + 1; j < merged.length; j++) {
          const a = merged[i];
          const b = merged[j];

          const sameZ = Math.abs(a.minZ - b.minZ) <= tolerance && Math.abs(a.maxZ - b.maxZ) <= tolerance;
          const touchX = Math.abs(a.maxX - b.minX) <= tolerance || Math.abs(b.maxX - a.minX) <= tolerance;

          if (sameZ && touchX) {
            const combined = {
              minX: Math.min(a.minX, b.minX),
              maxX: Math.max(a.maxX, b.maxX),
              minZ: Math.min(a.minZ, b.minZ),
              maxZ: Math.max(a.maxZ, b.maxZ)
            };

            merged.splice(j, 1);
            merged.splice(i, 1, { ...combined, area: rectArea(combined) });
            changed = true;
            break outer;
          }

          const sameX = Math.abs(a.minX - b.minX) <= tolerance && Math.abs(a.maxX - b.maxX) <= tolerance;
          const touchZ = Math.abs(a.maxZ - b.minZ) <= tolerance || Math.abs(b.maxZ - a.minZ) <= tolerance;

          if (sameX && touchZ) {
            const combined = {
              minX: Math.min(a.minX, b.minX),
              maxX: Math.max(a.maxX, b.maxX),
              minZ: Math.min(a.minZ, b.minZ),
              maxZ: Math.max(a.maxZ, b.maxZ)
            };

            merged.splice(j, 1);
            merged.splice(i, 1, { ...combined, area: rectArea(combined) });
            changed = true;
            break outer;
          }
        }
      }
    }

    // One final duplicate guard after grid merging.
    const byKey = new Map();
    for (const rect of merged) {
      byKey.set(normalizedRectKey(rect), rect);
    }

    return [...byKey.values()].sort((a, b) => rectArea(b) - rectArea(a));
  }

  function classifySpaceCluster(storeyIndex, cluster, clusterBounds, totalStoreyArea) {
    const text = cluster.map(r => searchableText(r.mesh)).join(' ');
    const area = cluster.reduce((sum, r) => sum + r.area, 0);
    const areaRatio = area / Math.max(totalStoreyArea, 0.0001);

    const lower = text.toLowerCase();

    const hasTerraceText = /(terrace|terrasse|roof terrace|toit terrasse|patio|deck)/i.test(lower);
    const hasBalconyText = /(balcony|balcon|loggia)/i.test(lower);
    const hasStairText = /(stair|stairs|staircase|escalier|escaliers|palier|landing|marche|marches)/i.test(lower);

    const stairNearby = meshes.some(m => {
      if (m.storeyIndex !== storeyIndex || m.classification !== 'stair') return false;
      const s = {
        minX: m.bbox.min[0],
        maxX: m.bbox.max[0],
        minZ: m.bbox.min[2],
        maxZ: m.bbox.max[2]
      };
      return rectsTouchOrOverlap(clusterBounds, s, 0.70);
    });

    const verySmall = area < Math.max(2.5, totalStoreyArea * 0.04);
    const narrow = Math.min(clusterBounds.maxX - clusterBounds.minX, clusterBounds.maxZ - clusterBounds.minZ) < 1.25;
    const externalHint = /(outside|extérieur|exterieur|external|terrace|terrasse|balcony|balcon|loggia|patio|deck)/i.test(lower);

    if (hasStairText || (stairNearby && verySmall)) {
      return {
        key: 'stair',
        label: 'Stair Space',
        zoneLabel: 'Stair Zone',
        predefinedType: '.INTERNAL.'
      };
    }

    if (hasBalconyText || (externalHint && narrow && areaRatio < 0.25)) {
      return {
        key: 'balcony',
        label: 'Balcony Space',
        zoneLabel: 'Balcony Zone',
        predefinedType: '.EXTERNAL.'
      };
    }

    if (hasTerraceText || (externalHint && areaRatio >= 0.08)) {
      return {
        key: 'terrace',
        label: 'Terrace Space',
        zoneLabel: 'Terrace Zone',
        predefinedType: '.EXTERNAL.'
      };
    }

    return {
      key: 'main',
      label: 'Main Space',
      zoneLabel: 'Main Zone',
      predefinedType: '.INTERNAL.'
    };
  }

  function clusterHasExplicitSmallSpaceIntent(cluster) {
    return cluster.some(rect => {
      const text = searchableText(rect.mesh);
      return hasStairHint(rect.mesh) || /(palier|landing|marche|stair|escalier|terrace|terrasse|balcony|balcon|loggia|deck|patio)/i.test(text);
    });
  }

  function minimumSpaceAreaForCategory(category, totalStoreyArea, explicitIntent = false) {
    const relative = Math.max(1.0, totalStoreyArea * 0.012);

    if (category.key === 'main') {
      return Math.max(4.00, totalStoreyArea * 0.020);
    }

    if (category.key === 'terrace') {
      return explicitIntent ? 1.80 : Math.max(3.00, relative);
    }

    if (category.key === 'balcony') {
      return explicitIntent ? 1.20 : Math.max(2.00, relative);
    }

    if (category.key === 'stair') {
      return explicitIntent ? 1.20 : Math.max(2.00, relative);
    }

    return Math.max(3.00, relative);
  }

  function selectRoomPrototypeStoreyIndex() {
    let best = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < storeys.length; i++) {
      const slabs = slabRectsForStorey(i);
      const floorArea = slabs.reduce((sum, slab) => sum + slab.area, 0);
      const wallCount = meshes.filter(m => m.storeyIndex === i && m.classification === 'wall').length;
      const score = floorArea + wallCount * 1.5;

      if (floorArea >= 12 && wallCount >= 2 && score > bestScore) {
        best = i;
        bestScore = score;
      }
    }

    return best;
  }

  const roomPrototypeStoreyIndex = selectRoomPrototypeStoreyIndex();

  function rectCoverageRatioByRects(rect, coveringRects) {
    const area = rectArea(rect);
    if (area <= 0) return 0;

    let covered = 0;
    for (const source of coveringRects) {
      covered += rectIntersectionArea(rect, source, 0.01);
    }

    return Math.min(1, covered / area);
  }

  function interiorWallCutsForCluster(storeyIndex, bounds) {
    const xCuts = [];
    const zCuts = [];

    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;

    for (const wall of meshes) {
      if (wall.storeyIndex !== storeyIndex || wall.classification !== 'wall') continue;

      const w = {
        minX: wall.bbox.min[0],
        maxX: wall.bbox.max[0],
        minZ: wall.bbox.min[2],
        maxZ: wall.bbox.max[2]
      };

      if (!rectsTouchOrOverlap(bounds, w, 0.05)) continue;

      const sx = w.maxX - w.minX;
      const sz = w.maxZ - w.minZ;
      const centerX = (w.minX + w.maxX) / 2;
      const centerZ = (w.minZ + w.maxZ) / 2;

      const awayFromOuterX = centerX > bounds.minX + 0.55 && centerX < bounds.maxX - 0.55;
      const awayFromOuterZ = centerZ > bounds.minZ + 0.55 && centerZ < bounds.maxZ - 0.55;

      if (sz > sx * 2.2 && sx <= 0.75 && awayFromOuterX && sz >= depth * 0.38) {
        xCuts.push(centerX);
      }

      if (sx > sz * 2.2 && sz <= 0.75 && awayFromOuterZ && sx >= width * 0.38) {
        zCuts.push(centerZ);
      }
    }

    function compactCuts(values, minDistance = 0.90) {
      const sorted = [...values].sort((a, b) => a - b);
      const out = [];

      for (const value of sorted) {
        if (out.length === 0 || Math.abs(value - out[out.length - 1]) >= minDistance) {
          out.push(value);
        }
      }

      return out.slice(0, 5);
    }

    return {
      xCuts: compactCuts(xCuts),
      zCuts: compactCuts(zCuts)
    };
  }

  function wallBlocksSharedBoundary(a, b, storeyIndex, tolerance = 0.32) {
    const verticalShare =
      Math.abs(a.maxX - b.minX) <= tolerance ||
      Math.abs(b.maxX - a.minX) <= tolerance;

    const horizontalShare =
      Math.abs(a.maxZ - b.minZ) <= tolerance ||
      Math.abs(b.maxZ - a.minZ) <= tolerance;

    for (const wall of meshes) {
      if (wall.storeyIndex !== storeyIndex || wall.classification !== 'wall') continue;

      const w = {
        minX: wall.bbox.min[0],
        maxX: wall.bbox.max[0],
        minZ: wall.bbox.min[2],
        maxZ: wall.bbox.max[2]
      };

      const wallWidthX = w.maxX - w.minX;
      const wallWidthZ = w.maxZ - w.minZ;
      const wallCenterX = (w.minX + w.maxX) / 2;
      const wallCenterZ = (w.minZ + w.maxZ) / 2;

      if (verticalShare) {
        const boundaryX = Math.abs(a.maxX - b.minX) <= tolerance
          ? (a.maxX + b.minX) / 2
          : (b.maxX + a.minX) / 2;

        const sharedMinZ = Math.max(a.minZ, b.minZ);
        const sharedMaxZ = Math.min(a.maxZ, b.maxZ);
        const sharedLength = Math.max(0, sharedMaxZ - sharedMinZ);
        const overlapZ = Math.max(0, Math.min(sharedMaxZ, w.maxZ) - Math.max(sharedMinZ, w.minZ));

        const wallOnBoundary = Math.abs(wallCenterX - boundaryX) <= Math.max(tolerance, wallWidthX / 2 + 0.12);
        const wallLongEnough = overlapZ >= Math.max(0.65, sharedLength * 0.45);
        const wallIsVerticalDivider = wallWidthX <= 0.95 && wallWidthZ >= Math.max(0.80, sharedLength * 0.35);

        if (wallOnBoundary && wallLongEnough && wallIsVerticalDivider) {
          return true;
        }
      }

      if (horizontalShare) {
        const boundaryZ = Math.abs(a.maxZ - b.minZ) <= tolerance
          ? (a.maxZ + b.minZ) / 2
          : (b.maxZ + a.minZ) / 2;

        const sharedMinX = Math.max(a.minX, b.minX);
        const sharedMaxX = Math.min(a.maxX, b.maxX);
        const sharedLength = Math.max(0, sharedMaxX - sharedMinX);
        const overlapX = Math.max(0, Math.min(sharedMaxX, w.maxX) - Math.max(sharedMinX, w.minX));

        const wallOnBoundary = Math.abs(wallCenterZ - boundaryZ) <= Math.max(tolerance, wallWidthZ / 2 + 0.12);
        const wallLongEnough = overlapX >= Math.max(0.65, sharedLength * 0.45);
        const wallIsHorizontalDivider = wallWidthZ <= 0.95 && wallWidthX >= Math.max(0.80, sharedLength * 0.35);

        if (wallOnBoundary && wallLongEnough && wallIsHorizontalDivider) {
          return true;
        }
      }
    }

    return false;
  }

  function cellsCanMerge(a, b, storeyIndex, tolerance = 0.12) {
    const sameZ = Math.abs(a.minZ - b.minZ) <= tolerance && Math.abs(a.maxZ - b.maxZ) <= tolerance;
    const touchX = Math.abs(a.maxX - b.minX) <= tolerance || Math.abs(b.maxX - a.minX) <= tolerance;

    if (sameZ && touchX && !wallBlocksSharedBoundary(a, b, storeyIndex)) {
      return true;
    }

    const sameX = Math.abs(a.minX - b.minX) <= tolerance && Math.abs(a.maxX - b.maxX) <= tolerance;
    const touchZ = Math.abs(a.maxZ - b.minZ) <= tolerance || Math.abs(b.maxZ - a.minZ) <= tolerance;

    if (sameX && touchZ && !wallBlocksSharedBoundary(a, b, storeyIndex)) {
      return true;
    }

    return false;
  }

  function mergeRoomCellsByOpenBoundaries(cells, storeyIndex) {
    let merged = [...cells];
    let changed = true;

    while (changed) {
      changed = false;

      outer:
      for (let i = 0; i < merged.length; i++) {
        for (let j = i + 1; j < merged.length; j++) {
          const a = merged[i];
          const b = merged[j];

          if (!cellsCanMerge(a, b, storeyIndex)) continue;

          const combined = {
            minX: Math.min(a.minX, b.minX),
            maxX: Math.max(a.maxX, b.maxX),
            minZ: Math.min(a.minZ, b.minZ),
            maxZ: Math.max(a.maxZ, b.maxZ)
          };

          merged.splice(j, 1);
          merged.splice(i, 1, {
            ...combined,
            area: rectArea(combined)
          });

          changed = true;
          break outer;
        }
      }
    }

    return merged.sort((a, b) => rectArea(b) - rectArea(a));
  }

  function snapRectToNearbyWalls(rect, storeyIndex, maxGap = 1.10) {
    const snapped = { ...rect };

    const walls = meshes.filter(m => m.storeyIndex === storeyIndex && m.classification === 'wall');

    function currentDepth() {
      return Math.max(0.001, snapped.maxZ - snapped.minZ);
    }

    function currentWidth() {
      return Math.max(0.001, snapped.maxX - snapped.minX);
    }

    function overlapZ(wall) {
      return Math.max(0, Math.min(snapped.maxZ, wall.bbox.max[2]) - Math.max(snapped.minZ, wall.bbox.min[2]));
    }

    function overlapX(wall) {
      return Math.max(0, Math.min(snapped.maxX, wall.bbox.max[0]) - Math.max(snapped.minX, wall.bbox.min[0]));
    }

    let bestLeft = null;
    let bestRight = null;
    let bestBottom = null;
    let bestTop = null;

    for (const wall of walls) {
      const wx = wall.bbox.max[0] - wall.bbox.min[0];
      const wz = wall.bbox.max[2] - wall.bbox.min[2];

      // Snap X edges to nearby Z-oriented walls.
      if (wz >= Math.max(0.80, currentDepth() * 0.35) && overlapZ(wall) >= Math.max(0.55, currentDepth() * 0.25)) {
        const leftGap = snapped.minX - wall.bbox.max[0];
        if (leftGap > 0.05 && leftGap <= maxGap) {
          if (!bestLeft || leftGap < bestLeft.gap) bestLeft = { value: wall.bbox.max[0], gap: leftGap };
        }

        const rightGap = wall.bbox.min[0] - snapped.maxX;
        if (rightGap > 0.05 && rightGap <= maxGap) {
          if (!bestRight || rightGap < bestRight.gap) bestRight = { value: wall.bbox.min[0], gap: rightGap };
        }
      }

      // Snap Z edges to nearby X-oriented walls.
      if (wx >= Math.max(0.80, currentWidth() * 0.35) && overlapX(wall) >= Math.max(0.55, currentWidth() * 0.25)) {
        const bottomGap = snapped.minZ - wall.bbox.max[2];
        if (bottomGap > 0.05 && bottomGap <= maxGap) {
          if (!bestBottom || bottomGap < bestBottom.gap) bestBottom = { value: wall.bbox.max[2], gap: bottomGap };
        }

        const topGap = wall.bbox.min[2] - snapped.maxZ;
        if (topGap > 0.05 && topGap <= maxGap) {
          if (!bestTop || topGap < bestTop.gap) bestTop = { value: wall.bbox.min[2], gap: topGap };
        }
      }
    }

    if (bestLeft) snapped.minX = bestLeft.value;
    if (bestRight) snapped.maxX = bestRight.value;
    if (bestBottom) snapped.minZ = bestBottom.value;
    if (bestTop) snapped.maxZ = bestTop.value;

    // New in v7: clamp, not only expand. If a generated space slightly crosses
    // a nearby wall face, pull the boundary back to the wall. This targets cases
    // where room prototype cells extend a bit beyond a real partition wall.
    // v8: stronger clamp for real partition walls.
    // v7 only corrected small overruns. Some generated room spaces can cross a
    // thick wall by 1.5-2.5m when the source slab footprint is larger than the
    // actual room. Allow a larger correction, but only for walls that satisfy
    // the divider tests below.
    const maxOverrun = Math.max(1.05, Math.min(2.60, Math.max(currentWidth(), currentDepth()) * 0.32));
    let clampLeft = null;
    let clampRight = null;
    let clampBottom = null;
    let clampTop = null;

    for (const wall of walls) {
      const wx = wall.bbox.max[0] - wall.bbox.min[0];
      const wz = wall.bbox.max[2] - wall.bbox.min[2];

      const zOverlap = overlapZ(wall);
      const xOverlap = overlapX(wall);

      const zDivider =
        wz >= Math.max(0.80, currentDepth() * 0.30) &&
        zOverlap >= Math.max(0.55, currentDepth() * 0.25) &&
        wx <= 1.10;

      if (zDivider) {
        const leftOverrun = wall.bbox.max[0] - snapped.minX;
        if (leftOverrun > 0.05 && leftOverrun <= maxOverrun && wall.bbox.max[0] < snapped.maxX - 1.00) {
          if (!clampLeft || leftOverrun < clampLeft.overrun) clampLeft = { value: wall.bbox.max[0], overrun: leftOverrun };
        }

        const rightOverrun = snapped.maxX - wall.bbox.min[0];
        if (rightOverrun > 0.05 && rightOverrun <= maxOverrun && wall.bbox.min[0] > snapped.minX + 1.00) {
          if (!clampRight || rightOverrun < clampRight.overrun) clampRight = { value: wall.bbox.min[0], overrun: rightOverrun };
        }
      }

      const xDivider =
        wx >= Math.max(0.80, currentWidth() * 0.30) &&
        xOverlap >= Math.max(0.55, currentWidth() * 0.25) &&
        wz <= 1.10;

      if (xDivider) {
        const bottomOverrun = wall.bbox.max[2] - snapped.minZ;
        if (bottomOverrun > 0.05 && bottomOverrun <= maxOverrun && wall.bbox.max[2] < snapped.maxZ - 1.00) {
          if (!clampBottom || bottomOverrun < clampBottom.overrun) clampBottom = { value: wall.bbox.max[2], overrun: bottomOverrun };
        }

        const topOverrun = snapped.maxZ - wall.bbox.min[2];
        if (topOverrun > 0.05 && topOverrun <= maxOverrun && wall.bbox.min[2] > snapped.minZ + 1.00) {
          if (!clampTop || topOverrun < clampTop.overrun) clampTop = { value: wall.bbox.min[2], overrun: topOverrun };
        }
      }
    }

    if (clampLeft && clampLeft.value < snapped.maxX - 1.00) snapped.minX = clampLeft.value;
    if (clampRight && clampRight.value > snapped.minX + 1.00) snapped.maxX = clampRight.value;
    if (clampBottom && clampBottom.value < snapped.maxZ - 1.00) snapped.minZ = clampBottom.value;
    if (clampTop && clampTop.value > snapped.minZ + 1.00) snapped.maxZ = clampTop.value;

    snapped.area = rectArea(snapped);
    return snapped;
  }

  function roomPrototypeRectsForCluster(storeyIndex, cluster, clusterBounds) {
    const cuts = interiorWallCutsForCluster(storeyIndex, clusterBounds);
    if (cuts.xCuts.length + cuts.zCuts.length === 0) return null;

    const xs = [clusterBounds.minX, ...cuts.xCuts, clusterBounds.maxX].sort((a, b) => a - b);
    const zs = [clusterBounds.minZ, ...cuts.zCuts, clusterBounds.maxZ].sort((a, b) => a - b);

    const cells = [];
    for (let xi = 0; xi < xs.length - 1; xi++) {
      for (let zi = 0; zi < zs.length - 1; zi++) {
        const cell = {
          minX: xs[xi],
          maxX: xs[xi + 1],
          minZ: zs[zi],
          maxZ: zs[zi + 1]
        };

        const area = rectArea(cell);
        if (area < 4.0) continue;

        const coverage = rectCoverageRatioByRects(cell, cluster);
        if (coverage < 0.55) continue;

        cells.push({
          ...cell,
          area
        });
      }
    }

    if (cells.length < 2 || cells.length > 24) return null;

    const merged = mergeRoomCellsByOpenBoundaries(cells, storeyIndex);

    if (merged.length < 2 || merged.length > 18) return null;

    return merged;
  }

  function createSpacePrismBoundsForRect(rect, minY, maxY) {
    const widthX = rect.maxX - rect.minX;
    const depthZ = rect.maxZ - rect.minZ;

    // Tiny inset to avoid exact coplanar overlap with slab/wall faces while
    // keeping spaces visually aligned to the slab footprint.
    const inset = Math.min(0.06, Math.max(0.01, Math.min(widthX, depthZ) * 0.008));

    return {
      minX: rect.minX + inset,
      maxX: rect.maxX - inset,
      minY,
      maxY,
      minZ: rect.minZ + inset,
      maxZ: rect.maxZ - inset
    };
  }

  function addZoneCommonPset(zoneId, area, categoryLabel) {
    const props = [
      addPropertySingleValue('Reference', `IFCIDENTIFIER('')`),
      addPropertySingleValue('Category', `IFCLABEL('${escapeIFCString(categoryLabel)}')`),
      addPropertySingleValue('IsExternal', `IFCBOOLEAN(${/(Terrace|Balcony)/.test(categoryLabel) ? '.T.' : '.F.'})`),
      addPropertySingleValue('GrossPlannedArea', `IFCAREAMEASURE(${formatMeasure(area)})`),
      addPropertySingleValue('NetPlannedArea', `IFCAREAMEASURE(${formatMeasure(area)})`)
    ];

    const pset = nextId();
    lines.push(`${pset}=IFCPROPERTYSET('${ifcGuid()}',${ownerHistory},'Pset_ZoneCommon',$,(${props.join(',')}));`);
    lines.push(`${nextId()}=IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',${ownerHistory},$,$,(${zoneId}),${pset});`);
  }

  function createZoneForStorey(storeyIndex, spaceIds, area, category) {
    if (!spaceIds || spaceIds.length === 0) return null;

    const zoneName = escapeIFCString(`${category.zoneLabel} - ${storeys[storeyIndex].name}`);
    const zoneId = nextId();

    // IFC4 IfcZone has no geometric representation here. It acts as a parent
    // grouping object for generated spaces of the same semantic category.
    lines.push(`${zoneId}=IFCZONE('${ifcGuid()}',${ownerHistory},'${zoneName}',$,'${escapeIFCString(category.key)}','${zoneName}');`);
    addZoneCommonPset(zoneId, area, category.zoneLabel);

    lines.push(`${nextId()}=IFCRELASSIGNSTOGROUP('${ifcGuid()}',${ownerHistory},'${zoneName} assignment',$,(${spaceIds.join(',')}),$,${zoneId});`);

    return zoneId;
  }

  function createSlabDrivenSpacesForStorey(storeyIndex) {
    const storey = storeys[storeyIndex];
    const rects = slabRectsForStorey(storeyIndex);

    if (rects.length === 0) return [];

    const totalStoreyArea = rects.reduce((sum, rect) => sum + rect.area, 0);
    const clusters = clusterSlabRects(rects);
    const created = [];
    const counters = { main: 0, terrace: 0, balcony: 0, stair: 0 };

    for (const cluster of clusters) {
      const raw = boundsFromRects(cluster);
      if (!raw) continue;

      const widthX = raw.maxX - raw.minX;
      const depthZ = raw.maxZ - raw.minZ;
      if (widthX < 1.0 || depthZ < 1.0) continue;

      const category = classifySpaceCluster(storeyIndex, cluster, raw, totalStoreyArea);
      const clusterArea = cluster.reduce((sum, rect) => sum + rect.area, 0);
      const explicitSmallSpaceIntent = clusterHasExplicitSmallSpaceIntent(cluster);
      const minSpaceArea = minimumSpaceAreaForCategory(category, totalStoreyArea, explicitSmallSpaceIntent);

      if (clusterArea < minSpaceArea) {
        continue;
      }

      counters[category.key] = (counters[category.key] || 0) + 1;

      const slabTop = median(cluster.map(r => r.maxY));
      const minY = (Number.isFinite(slabTop) ? slabTop : storey.elevation) + 0.05;

      const nextStorey = storeys[storeyIndex + 1];
      let maxY;

      if (nextStorey && nextStorey.elevation - minY >= 1.60) {
        maxY = nextStorey.elevation - 0.12;
      } else {
        const estimated = estimateSpaceHeight(storeyIndex, cluster.map(r => r.mesh));
        maxY = minY + Math.max(1.80, Math.min(estimated - 0.15, category.key === 'stair' ? 4.20 : 3.80));
      }

      if (maxY <= minY + 1.20) continue;

      const roomPrototypeRects =
        category.key === 'main'
          ? roomPrototypeRectsForCluster(storeyIndex, cluster, raw)
          : null;

      const spaceParts = roomPrototypeRects || [null];

      for (const partRect of spaceParts) {
        const rawSourceRects = partRect ? [partRect] : mergeRectsIntoCells(cluster);
        const sourceRects = rawSourceRects
          .map(rect => snapRectToNearbyWalls(rect, storeyIndex))
          .filter(rect => rectArea(rect) >= 0.80);

        const faceSets = [];
        const boundaryRects = [];
        let grossArea = 0;
        let weightedHeight = 0;
        let hasSlopedRoofTop = false;
        let roofTopSource = null;

        for (const rect of sourceRects) {
          const bounds = createSpacePrismBoundsForRect(rect, minY, maxY);
          if (bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) continue;

          const area = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ);
          if (area < 0.80) continue;

          const roofTop = !storeys[storeyIndex + 1]
            ? variableTopFromRoof(bounds, maxY)
            : null;

          const faceSet = roofTop
            ? makeVariableTopBoxTriangulatedFaceSet(bounds, roofTop)
            : makeBoxTriangulatedFaceSet(bounds);

          const topAverage = roofTop
            ? (roofTop.p0 + roofTop.p1 + roofTop.p2 + roofTop.p3) / 4
            : bounds.maxY;

          grossArea += area;
          weightedHeight += area * Math.max(0, topAverage - bounds.minY);
          hasSlopedRoofTop = hasSlopedRoofTop || Boolean(roofTop);
          if (roofTop?.source === 'beam') {
            roofTopSource = 'beam';
          } else if (roofTop && !roofTopSource) {
            roofTopSource = 'roof';
          }
          faceSets.push(faceSet);
          boundaryRects.push({
            minX: bounds.minX,
            maxX: bounds.maxX,
            minZ: bounds.minZ,
            maxZ: bounds.maxZ,
            minY: bounds.minY,
            maxY: topAverage
          });
        }

        if (faceSets.length === 0 || grossArea < minSpaceArea) {
          continue;
        }

        const styleByCategory = {
          main: { r: 0.45, g: 0.72, b: 1.00 },
          terrace: { r: 0.62, g: 0.82, b: 0.52 },
          balcony: { r: 0.60, g: 0.80, b: 0.92 },
          stair: { r: 0.90, g: 0.68, b: 0.42 }
        };

        const spaceStyle = getOrCreateStyle(styleByCategory[category.key] || styleByCategory.main, 0.35);
        if (spaceStyle) {
          for (const faceSet of faceSets) {
            lines.push(`${nextId()}=IFCSTYLEDITEM(${faceSet},(${spaceStyle.presStyle}),$);`);
          }
        }

        const shapeRep = nextId();
        lines.push(`${shapeRep}=IFCSHAPEREPRESENTATION(${styleContext},'Body','Tessellation',(${faceSets.join(',')}));`);
        queuePresentationLayer({ classification: 'space' }, shapeRep);

        const productShape = nextId();
        lines.push(`${productShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}));`);

        const placement = nextId();
        lines.push(`${placement}=IFCLOCALPLACEMENT(${storeyPlacements[storeyIndex]},${axis});`);

        const spaceId = nextId();
        const roomPrototype = Boolean(roomPrototypeRects);
        const roomCount = created.filter(s => s.roomPrototype).length + 1;
        const localSuffix = roomPrototype
          ? ` Room ${String(roomCount).padStart(2, '0')}`
          : (counters[category.key] > 1 ? ` ${String(counters[category.key]).padStart(2, '0')}` : '');

        const label = roomPrototype ? 'Room Prototype Space' : category.label;
        const semanticKey = roomPrototype ? 'room_prototype' : category.key;
        const spaceName = escapeIFCString(`${label} - ${storey.name}${localSuffix}`);
        lines.push(`${spaceId}=IFCSPACE('${ifcGuid()}',${ownerHistory},'${spaceName}',$,'${escapeIFCString(semanticKey)}',${placement},${productShape},'${spaceName}',.ELEMENT.,${category.predefinedType},$);`);

        addSpaceCommonPset(spaceId);

        const averageHeight = weightedHeight / Math.max(grossArea, 0.0001);
        const volume = grossArea * averageHeight;

        const hasQuantities = addElementQuantity(spaceId, 'Qto_SpaceBaseQuantities', [
          addQuantityArea('GrossFloorArea', grossArea),
          addQuantityArea('NetFloorArea', grossArea),
          addQuantityLength('Height', averageHeight),
          addQuantityVolume('GrossVolume', volume),
          addQuantityVolume('NetVolume', volume)
        ]);

        created.push({
          id: spaceId,
          area: grossArea,
          volume,
          category: roomPrototype
            ? { key: 'room', label: 'Room Prototype Space', zoneLabel: 'Room Prototype Zone', predefinedType: '.INTERNAL.' }
            : category,
          hasQuantities,
          rects: boundaryRects,
          storeyIndex,
          roomPrototype,
          hasSlopedRoofTop,
          roofTopSource
        });
      }
    }

    return created;
  }

  function rectTouchesRectBoundary(a, b, tolerance = 0.28) {
    const zOverlap = Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
    const xOverlap = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));

    const depthA = Math.max(0.001, a.maxZ - a.minZ);
    const widthA = Math.max(0.001, a.maxX - a.minX);

    const touchesLeft = Math.abs(a.minX - b.maxX) <= tolerance && zOverlap >= depthA * 0.18;
    const touchesRight = Math.abs(a.maxX - b.minX) <= tolerance && zOverlap >= depthA * 0.18;
    const touchesBottom = Math.abs(a.minZ - b.maxZ) <= tolerance && xOverlap >= widthA * 0.18;
    const touchesTop = Math.abs(a.maxZ - b.minZ) <= tolerance && xOverlap >= widthA * 0.18;

    return touchesLeft || touchesRight || touchesBottom || touchesTop;
  }

  function addApproximateSpaceBoundaries(spaceRecords, elementIdByMesh) {
    let count = 0;

    function addBoundary(spaceId, elementId, boundaryType = '.INTERNAL.') {
      if (!elementId) return;
      lines.push(`${nextId()}=IFCRELSPACEBOUNDARY('${ifcGuid()}',${ownerHistory},$,$,${spaceId},${elementId},$,.PHYSICAL.,${boundaryType});`);
      count++;
    }

    for (const space of spaceRecords) {
      const seen = new Set();

      const addForMesh = (mesh, boundaryType = '.INTERNAL.') => {
        const elementId = elementIdByMesh.get(mesh);
        if (!elementId || seen.has(elementId)) return;
        seen.add(elementId);
        addBoundary(space.id, elementId, boundaryType);
      };

      for (const rect of space.rects || []) {
        for (const mesh of meshes) {
          if (mesh.storeyIndex !== space.storeyIndex) continue;

          const elementRect = {
            minX: mesh.bbox.min[0],
            maxX: mesh.bbox.max[0],
            minZ: mesh.bbox.min[2],
            maxZ: mesh.bbox.max[2]
          };

          if (mesh.classification === 'wall') {
            const verticalOverlap =
              Math.min(rect.maxY, mesh.bbox.max[1]) - Math.max(rect.minY, mesh.bbox.min[1]);

            if (verticalOverlap > 0.40 && rectTouchesRectBoundary(rect, elementRect, 0.35)) {
              addForMesh(mesh, mesh.isExternal ? '.EXTERNAL.' : '.INTERNAL.');
            }
          }

          if (mesh.classification === 'slab') {
            const overlap = rectIntersectionArea(rect, elementRect, 0.02);
            const ratio = overlap / Math.max(0.0001, rectArea(rect));

            if (ratio > 0.25 && Math.abs(mesh.bbox.max[1] - rect.minY) < 0.45) {
              addForMesh(mesh, '.INTERNAL.');
            }
          }

          if (mesh.classification === 'roof' && space.hasSlopedRoofTop) {
            const overlap = rectIntersectionArea(rect, elementRect, 0.20);
            const ratio = overlap / Math.max(0.0001, rectArea(rect));

            if (ratio > 0.15) {
              addForMesh(mesh, '.EXTERNAL.');
            }
          }
        }

        if (space.hasSlopedRoofTop) {
          for (const roof of meshes.filter(m => m.classification === 'roof')) {
            const roofRect = {
              minX: roof.bbox.min[0],
              maxX: roof.bbox.max[0],
              minZ: roof.bbox.min[2],
              maxZ: roof.bbox.max[2]
            };

            const overlap = rectIntersectionArea(rect, roofRect, 0.20);
            const ratio = overlap / Math.max(0.0001, rectArea(rect));

            if (ratio > 0.15) {
              addForMesh(roof, '.EXTERNAL.');
            }
          }
        }
      }
    }

    return count;
  }

  // Build elements grouped by storey
  const elementsByStorey = Array.from({ length: storeys.length }, () => []);
  const stats = {
    wall: 0,
    slab: 0,
    beam: 0,
    column: 0,
    stair: 0,
    roof: 0,
    door: 0,
    window: 0,
    proxy: 0,
    externalWall: 0,
    fallbackColors: 0,
    quantities: 0,
    materials: 0,
    layers: 0,
    spaces: 0,
    manualSpaces: 0,
    zones: 0,
    roomPrototypeSpaces: 0,
    slopedRoofSpaces: 0,
    beamGuidedRoofSpaces: 0,
    spaceBoundaries: 0,
    openRoomCellMerge: true,
    wallSnapping: true,
    wallClamp: true,
    strongWallClamp: true,
    tinySpacesFiltered: true,
    inputScaleApplied: Boolean(scaleInfo?.applied),
    inputScale: Number(scaleInfo?.scale || 1),
    assumedInputUnit: scaleInfo?.assumedInputUnit || 'metre',
    outputUnit: scaleInfo?.outputUnit || 'metre',
    scaleReason: scaleInfo?.reason || '',
    originalMaxDimension: Number(scaleInfo?.originalMaxDimension || 0),
    normalizedMaxDimension: Number(scaleInfo?.normalizedMaxDimension || 0)
  };

  const nameCounters = { wall: 0, slab: 0, beam: 0, column: 0, stair: 0, roof: 0, door: 0, window: 0, proxy: 0, space: 0 };
  const nameLabels = {
    wall: 'Wall',
    slab: 'Slab',
    beam: 'Beam',
    column: 'Column',
    stair: 'Stair',
    roof: 'Roof',
    door: 'Door',
    window: 'Window',
    proxy: 'Proxy',
    space: 'Space'
  };

  function generatedElementName(mesh) {
    const key = Object.prototype.hasOwnProperty.call(nameCounters, mesh.classification)
      ? mesh.classification
      : 'proxy';

    nameCounters[key] += 1;
    return `${nameLabels[key]} ${String(nameCounters[key]).padStart(3, '0')}`;
  }

  const spaceEntitiesByStorey = Array.from({ length: storeys.length }, () => []);
  const zoneEntitiesByStorey = Array.from({ length: storeys.length }, () => []);
  const allSpaceRecords = [];
  const elementIdByMesh = new Map();
  const manualSpaceMeshes = meshes.filter(isManualSpaceMesh);

  function createManualSpaceFromMesh(mesh) {
    const coords = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i];
      const y = mesh.positions[i + 1];
      const z = mesh.positions[i + 2];
      coords.push(`(${x.toFixed(6)},${(-z).toFixed(6)},${y.toFixed(6)})`);
    }

    const pointList = nextId();
    lines.push(`${pointList}=IFCCARTESIANPOINTLIST3D((${coords.join(',')}));`);

    const faces = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      faces.push(`(${mesh.indices[i] + 1},${mesh.indices[i + 1] + 1},${mesh.indices[i + 2] + 1})`);
    }

    const faceSet = nextId();
    lines.push(`${faceSet}=IFCTRIANGULATEDFACESET(${pointList},$,$,(${faces.join(',')}),$);`);

    const style = getOrCreateStyle(mesh.color || DEFAULT_CLASS_COLORS.space, 0.35);
    if (style) lines.push(`${nextId()}=IFCSTYLEDITEM(${faceSet},(${style.presStyle}),$);`);

    const shapeRep = nextId();
    lines.push(`${shapeRep}=IFCSHAPEREPRESENTATION(${styleContext},'Body','Tessellation',(${faceSet}));`);
    queuePresentationLayer({ classification: 'space' }, shapeRep);

    const productShape = nextId();
    lines.push(`${productShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}));`);

    const storeyIndex = Math.max(0, Math.min(storeys.length - 1, Number.isFinite(mesh.storeyIndex) ? mesh.storeyIndex : 0));
    const placement = nextId();
    lines.push(`${placement}=IFCLOCALPLACEMENT(${storeyPlacements[storeyIndex]},${axis});`);

    const safeName = escapeIFCString(mesh.name || generatedElementName({ classification: 'space' }));
    const predefinedRaw = String(mesh.smeltPredefinedType || '.INTERNAL.').trim().toUpperCase();
    const predefined = /^\.[A-Z0-9_]+\.$/.test(predefinedRaw) ? predefinedRaw : '.INTERNAL.';
    const spaceId = nextId();
    lines.push(`${spaceId}=IFCSPACE('${ifcGuid()}',${ownerHistory},'${safeName}',$,'manual_space',${placement},${productShape},'${safeName}',.ELEMENT.,${predefined},$);`);

    addSpaceCommonPset(spaceId);

    const s = bboxStats(mesh);
    const grossArea = Math.max(0.0001, s.sizeX * s.sizeZ);
    const height = Math.max(0.0001, s.sizeY);
    const volume = grossArea * height;
    if (addElementQuantity(spaceId, 'Qto_SpaceBaseQuantities', [
      addQuantityArea('GrossFloorArea', grossArea),
      addQuantityArea('NetFloorArea', grossArea),
      addQuantityLength('Height', height),
      addQuantityVolume('GrossVolume', volume),
      addQuantityVolume('NetVolume', volume)
    ])) {
      stats.quantities++;
    }

    spaceEntitiesByStorey[storeyIndex].push(spaceId);
    stats.spaces++;
    stats.manualSpaces++;
    return spaceId;
  }

  if (manualSpaceMeshes.length === 0) {
    for (let i = 0; i < storeys.length; i++) {
      const spaces = createSlabDrivenSpacesForStorey(i);
      if (spaces.length === 0) continue;

      const ids = spaces.map(space => space.id);

      allSpaceRecords.push(...spaces);
      spaceEntitiesByStorey[i].push(...ids);
      stats.spaces += spaces.length;
      stats.roomPrototypeSpaces += spaces.filter(space => space.roomPrototype).length;
      stats.slopedRoofSpaces += spaces.filter(space => space.hasSlopedRoofTop).length;
      stats.beamGuidedRoofSpaces += spaces.filter(space => space.roofTopSource === 'beam').length;

      for (const space of spaces) {
        if (space.hasQuantities) stats.quantities++;
      }

      const byCategory = new Map();
      for (const space of spaces) {
        const key = space.category.key;
        if (!byCategory.has(key)) {
          byCategory.set(key, {
            category: space.category,
            ids: [],
            area: 0
          });
        }

        const group = byCategory.get(key);
        group.ids.push(space.id);
        group.area += space.area;
      }

      for (const group of byCategory.values()) {
        const zone = createZoneForStorey(i, group.ids, group.area, group.category);
        if (zone) {
          zoneEntitiesByStorey[i].push(zone);
          stats.zones++;
        }
      }
    }
  } else {
    stats.autoSpacesReplacedByManual = true;
    for (const mesh of manualSpaceMeshes) createManualSpaceFromMesh(mesh);
  }

  for (const mesh of meshes) {
    if (isManualSpaceMesh(mesh)) continue;
    stats[mesh.classification]++;
    if (mesh.classification === 'wall' && mesh.isExternal) stats.externalWall++;

    // Coords (Y-up glTF → Z-up IFC)
    const coords = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i];
      const y = mesh.positions[i + 1];
      const z = mesh.positions[i + 2];
      coords.push(`(${x.toFixed(6)},${(-z).toFixed(6)},${y.toFixed(6)})`);
    }

    const pointList = nextId();
    lines.push(`${pointList}=IFCCARTESIANPOINTLIST3D((${coords.join(',')}));`);

    const faces = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      faces.push(`(${mesh.indices[i] + 1},${mesh.indices[i + 1] + 1},${mesh.indices[i + 2] + 1})`);
    }

    const faceSet = nextId();
    lines.push(`${faceSet}=IFCTRIANGULATEDFACESET(${pointList},$,$,(${faces.join(',')}),$);`);

    // Apply color via IfcStyledItem. Keep source GLB colors when they look
    // meaningful; otherwise apply a readable fallback color by IFC class so
    // unstyled models do not appear completely white in IFC viewers.
    const displayColor = colorForMesh(mesh);
    if (mesh.usedFallbackColor) stats.fallbackColors++;

    const style = getOrCreateStyle(displayColor);
    if (style) {
      lines.push(`${nextId()}=IFCSTYLEDITEM(${faceSet},(${style.presStyle}),$);`);
    }

    const shapeRep = nextId();
    lines.push(`${shapeRep}=IFCSHAPEREPRESENTATION(${styleContext},'Body','Tessellation',(${faceSet}));`);
    queuePresentationLayer(mesh, shapeRep);

    const productShape = nextId();
    lines.push(`${productShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}));`);

    const placement = nextId();
    const storeyPlacement = storeyPlacements[mesh.storeyIndex];
    lines.push(`${placement}=IFCLOCALPLACEMENT(${storeyPlacement},${axis});`);

    const elemId = nextId();
    elementIdByMesh.set(mesh, elemId);
    const safeName = escapeIFCString(generatedElementName(mesh));

    // IfcDoor (13 attrs in IFC4): GlobalId, Owner, Name, Desc, ObjType, Placement,
    //   Repr, Tag, OverallHeight, OverallWidth, PredefinedType, OperationType, UserDef
    if (mesh.classification === 'door') {
      const [minX, minY, minZ] = mesh.bbox.min;
      const [maxX, maxY, maxZ] = mesh.bbox.max;
      const height = (maxY - minY).toFixed(4);
      const width  = Math.max(maxX - minX, maxZ - minZ).toFixed(4);
      lines.push(`${elemId}=IFCDOOR('${ifcGuid()}',${ownerHistory},'${safeName}',$,$,${placement},${productShape},$,${height},${width},.DOOR.,.NOTDEFINED.,$);`);
    } else if (mesh.classification === 'window') {
      const [minX, minY, minZ] = mesh.bbox.min;
      const [maxX, maxY, maxZ] = mesh.bbox.max;
      const height = (maxY - minY).toFixed(4);
      const width  = Math.max(maxX - minX, maxZ - minZ).toFixed(4);
      lines.push(`${elemId}=IFCWINDOW('${ifcGuid()}',${ownerHistory},'${safeName}',$,$,${placement},${productShape},$,${height},${width},.WINDOW.,.NOTDEFINED.,$);`);
    } else {
      const typeInfo = IFC_TYPE_MAP[mesh.classification];
      lines.push(`${elemId}=${typeInfo.class}('${ifcGuid()}',${ownerHistory},'${safeName}',$,$,${placement},${productShape},$,${typeInfo.predefined});`);

      if (mesh.classification === 'wall') {
        addWallCommonPset(elemId, mesh);
      } else if (mesh.classification === 'beam') {
        addBeamCommonPset(elemId, mesh);
      } else if (mesh.classification === 'column') {
        addColumnCommonPset(elemId, mesh);
      } else if (mesh.classification === 'stair') {
        addStairCommonPset(elemId, mesh);
      } else if (mesh.classification === 'roof') {
        addRoofCommonPset(elemId, mesh);
      }
    }

    if (approximateElementQuantities(mesh, elemId)) {
      stats.quantities++;
    }

    queueMaterialAssociation(mesh, elemId);
    queueUniformatAssociation(mesh, elemId);
    elementsByStorey[mesh.storeyIndex].push(elemId);
  }

  // Containment relations
  for (let i = 0; i < storeys.length; i++) {
    const elems = elementsByStorey[i];
    if (elems.length === 0) continue;
    lines.push(`${nextId()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',${ownerHistory},$,$,(${elems.join(',')}),${storeyEntities[i]});`);
  }

  // Spaces are spatial elements, so relate them to their storey through
  // IfcRelAggregates rather than element containment.
  for (let i = 0; i < storeys.length; i++) {
    const spaces = spaceEntitiesByStorey[i];
    if (spaces.length === 0) continue;
    lines.push(`${nextId()}=IFCRELAGGREGATES('${ifcGuid()}',${ownerHistory},$,$,${storeyEntities[i]},(${spaces.join(',')}));`);
  }

  stats.spaceBoundaries = addApproximateSpaceBoundaries(allSpaceRecords, elementIdByMesh);

  const layerCounts = addPresentationLayerAssignments();
  stats.layers = Object.keys(layerCounts).length;
  stats.layerNames = layerCounts;

  const materialCounts = addMaterialAssociations();
  stats.materials = Object.keys(materialCounts).length;
  stats.materialNames = materialCounts;

  const uniformatCounts = addUniformatAssociations();
  stats.uniformat = uniformatCounts;
  stats.uniformatCodes = Object.keys(uniformatCounts).length;

  const footer = ['ENDSEC;', 'END-ISO-10303-21;'];
  return {
    content: [...header, ...lines, ...footer].join('\n'),
    stats,
    storeyCount: storeys.length
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Qwen / llama.cpp IFC classification assistant
// ─────────────────────────────────────────────────────────────────────────────

function normalizeConfiguredPath(value) {
  const clean = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!clean) return '';
  if (clean === '~') return os.homedir();
  if (clean.startsWith(`~${path.sep}`) || clean.startsWith('~/')) {
    return path.join(os.homedir(), clean.slice(2));
  }
  return path.isAbsolute(clean) ? clean : path.resolve(__dirname, clean);
}

function executableExists(filePath) {
  if (!filePath) return false;
  try {
    const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
    fs.accessSync(filePath, mode);
    return true;
  } catch (_) {
    return false;
  }
}

function uniqueStrings(values, caseInsensitive = process.platform === 'win32') {
  const seen = new Set();
  const out = [];
  for (const value of values.filter(Boolean)) {
    const key = caseInsensitive ? String(value).toLowerCase() : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function executableNamesForPlatform(name, { includeScripts = false } = {}) {
  if (process.platform !== 'win32') return [name];
  if (path.extname(name)) return [name];

  // Keep common-location diagnostics readable. For managed startup we only need
  // the real binary name; PATH probing below may also try .cmd/.bat shims.
  const names = [`${name}.exe`, name];
  if (includeScripts) names.push(`${name}.cmd`, `${name}.bat`);
  return uniqueStrings(names);
}

function findExecutableInPath(name) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = executableNamesForPlatform(name, { includeScripts: true });
  for (const entry of pathEntries) {
    for (const executableName of names) {
      const candidate = path.join(entry, executableName);
      if (executableExists(candidate)) return candidate;
    }
  }
  return null;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates
    .filter(Boolean)
    .map((candidate) => normalizeConfiguredPath(candidate))
    .filter((candidate) => {
      const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function llamaCppCandidateRoots() {
  const roots = [
    process.env.QWEN_LLAMA_CPP_DIR,
    process.env.LLAMA_CPP_DIR,
    path.join(__dirname, '.tools', 'llama.cpp'),
    path.join(__dirname, 'tools', 'llama.cpp'),
    path.join(__dirname, 'llama.cpp'),
    path.resolve(__dirname, '..', 'llama.cpp'),
    path.resolve(__dirname, '..', '..', 'llama.cpp'),
  ];

  if (process.platform === 'win32') {
    const projectDrive = path.parse(__dirname).root || 'C:\\';
    roots.push(path.win32.join(projectDrive, 'Github', 'llama.cpp'));
    roots.push('F:\\Github\\llama.cpp');
    roots.push('C:\\Github\\llama.cpp');
  }

  return uniqueCandidates(roots);
}

function llamaServerCandidatePaths() {
  const names = process.platform === 'win32' ? ['llama-server.exe'] : ['llama-server'];
  const roots = llamaCppCandidateRoots();

  const suffixDirs = [
    path.join('build', 'bin', 'Release'),
    path.join('build', 'bin', 'RelWithDebInfo'),
    path.join('build', 'bin', 'Debug'),
    path.join('build', 'bin'),
    path.join('bin', 'Release'),
    'bin',
    path.join('examples', 'server', 'Release'),
    path.join('server', 'Release'),
    '',
  ];

  const localCandidates = [];
  for (const root of roots) {
    for (const suffixDir of suffixDirs) {
      for (const name of names) localCandidates.push(path.join(root, suffixDir, name));
    }
  }

  return uniqueCandidates([
    ...localCandidates,
    findExecutableInPath('llama-server'),
  ]);
}

const QWEN_LLAMA_SERVER_CANDIDATES = llamaServerCandidatePaths();

function resolveLlamaServerBin() {
  if (process.env.QWEN_LLAMA_SERVER_BIN) {
    return normalizeConfiguredPath(process.env.QWEN_LLAMA_SERVER_BIN);
  }

  return QWEN_LLAMA_SERVER_CANDIDATES.find(executableExists) || '';
}

function qwenExpectedLlamaServerLabel() {
  return process.env.QWEN_LLAMA_SERVER_BIN
    ? normalizeConfiguredPath(process.env.QWEN_LLAMA_SERVER_BIN)
    : (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
}

function qwenSetupTip() {
  if (process.platform === 'win32') {
    return 'Tip: run "bun run qwen:doctor", then "bun run qwen:setup:windows", or set QWEN_LLAMA_SERVER_BIN in .env.local.';
  }
  return 'Tip: run "bun run qwen:doctor", then "bun run qwen:setup", or set QWEN_LLAMA_SERVER_BIN in .env.local.';
}

function resolveQwenModelPath() {
  if (process.env.QWEN_MODEL_PATH) {
    return normalizeConfiguredPath(process.env.QWEN_MODEL_PATH);
  }

  const modelsDir = path.join(__dirname, 'models');
  const defaultModelPath = path.join(modelsDir, 'Qwen3-Reranker-0.6B-Q4_K_M.gguf');
  if (fs.existsSync(defaultModelPath)) return defaultModelPath;

  if (!fs.existsSync(modelsDir)) return defaultModelPath;

  const files = fs.readdirSync(modelsDir)
    .filter((name) => name.toLowerCase().endsWith('.gguf'))
    .map((name) => path.join(modelsDir, name));

  const exactLower = files.find((file) => path.basename(file).toLowerCase() === 'qwen3-reranker-0.6b-q4_k_m.gguf');
  if (exactLower) return exactLower;

  const preferred = files.find((file) => /qwen3.*reranker.*0[._-]?6b.*q4.*k.*m.*\.gguf$/i.test(path.basename(file)));
  if (preferred) return preferred;

  const anyQwenReranker = files.find((file) => /qwen3.*reranker.*\.gguf$/i.test(path.basename(file)));
  if (anyQwenReranker) return anyQwenReranker;

  return files.length === 1 ? files[0] : defaultModelPath;
}

const QWEN_LLAMA_HOST = process.env.QWEN_LLAMA_HOST || '127.0.0.1';
const QWEN_LLAMA_PORT = Number(process.env.QWEN_LLAMA_PORT || 8081);
const QWEN_LLAMA_BASE_URL = process.env.QWEN_LLAMA_BASE_URL || `http://${QWEN_LLAMA_HOST}:${QWEN_LLAMA_PORT}`;

const DEFAULT_QWEN_RERANKER_URLS = [
  `${QWEN_LLAMA_BASE_URL}/v1/rerank`,
  `${QWEN_LLAMA_BASE_URL}/rerank`,
  `${QWEN_LLAMA_BASE_URL}/v1/reranking`,
  `${QWEN_LLAMA_BASE_URL}/reranking`,
];

const QWEN_RERANK_TIMEOUT_MS = Number(process.env.QWEN_RERANK_TIMEOUT_MS || 120000);
const QWEN_STARTUP_TIMEOUT_MS = Number(process.env.QWEN_STARTUP_TIMEOUT_MS || 120000);
const QWEN_RERANKER_URL = process.env.QWEN_RERANKER_URL || '';
const QWEN_AUTO_START = !['0', 'false', 'off', 'no'].includes(String(process.env.QWEN_AUTO_START ?? '1').toLowerCase());
const QWEN_LLAMA_SERVER_BIN = resolveLlamaServerBin();
const QWEN_MODEL_PATH = resolveQwenModelPath();
const QWEN_LLAMA_CONTEXT = Number(process.env.QWEN_LLAMA_CONTEXT || 4096);
// llama.cpp rerank pairs include the shared query plus each candidate document.
// The default physical batch size can be 512 on some builds, which is too
// small once geometry/context is included. 1024 keeps the setup light while
// avoiding "input tokens too large; increase physical batch size" errors.
const QWEN_LLAMA_BATCH = Number(process.env.QWEN_LLAMA_BATCH || process.env.QWEN_BATCH_SIZE || 1024);
const QWEN_LLAMA_UBATCH = Number(process.env.QWEN_LLAMA_UBATCH || process.env.QWEN_UBATCH_SIZE || 0);
const QWEN_LLAMA_THREADS = process.env.QWEN_LLAMA_THREADS || '';
const QWEN_GPU_LAYERS_RAW = process.env.QWEN_GPU_LAYERS || process.env.QWEN_LLAMA_GPU_LAYERS || '';
const QWEN_ALLOW_PROXY_TARGET = ['1', 'true', 'on', 'yes'].includes(String(process.env.QWEN_ALLOW_PROXY_TARGET || '').toLowerCase());
const QWEN_EXCLUDED_TARGET_TYPES = new Set(QWEN_ALLOW_PROXY_TARGET ? [] : ['IFCBUILDINGELEMENTPROXY']);
const QWEN_GPU_LAYERS = String(QWEN_GPU_LAYERS_RAW).toLowerCase() === 'auto' ? '99' : String(QWEN_GPU_LAYERS_RAW || '');


let qwenProcess = null;
let qwenShutdownHandlersAttached = false;
const qwenState = {
  mode: QWEN_RERANKER_URL ? 'external' : 'managed',
  status: QWEN_RERANKER_URL ? 'external' : 'not_started',
  modelPath: QWEN_MODEL_PATH,
  baseUrl: QWEN_LLAMA_BASE_URL,
  pid: null,
  startedAt: null,
  lastError: null,
  lastLog: '',
};

function appendQwenLog(chunk) {
  const text = String(chunk || '').trim();
  if (!text) return;
  qwenState.lastLog = `${qwenState.lastLog}
${text}`.slice(-4000);
  if (/listening|server is listening|http server|reranking/i.test(text)) {
    qwenState.status = 'ready';
  }
}

function qwenRuntimeStatus() {
  return {
    autoStart: QWEN_AUTO_START,
    mode: qwenState.mode,
    status: qwenState.status,
    baseUrl: qwenState.baseUrl,
    modelPath: qwenState.modelPath,
    llamaServerBin: QWEN_LLAMA_SERVER_BIN,
    configuredLlamaServerBin: process.env.QWEN_LLAMA_SERVER_BIN || null,
    testedLlamaServerCandidates: QWEN_LLAMA_SERVER_CANDIDATES.slice(0, 20),
    testedLlamaCppRoots: llamaCppCandidateRoots(),
    gpuLayers: QWEN_GPU_LAYERS || null,
    batchSize: Number.isFinite(QWEN_LLAMA_BATCH) && QWEN_LLAMA_BATCH > 0 ? QWEN_LLAMA_BATCH : null,
    microBatchSize: Number.isFinite(QWEN_LLAMA_UBATCH) && QWEN_LLAMA_UBATCH > 0 ? QWEN_LLAMA_UBATCH : null,
    rerankTimeoutMs: QWEN_RERANK_TIMEOUT_MS,
    startupTimeoutMs: QWEN_STARTUP_TIMEOUT_MS,
    pid: qwenState.pid,
    startedAt: qwenState.startedAt,
    lastError: qwenState.lastError,
    lastLog: qwenState.lastLog.slice(-1200),
    externalUrl: QWEN_RERANKER_URL || null,
  };
}

function attachQwenShutdownHandlers() {
  if (qwenShutdownHandlersAttached) return;
  qwenShutdownHandlersAttached = true;

  const stop = () => {
    if (qwenProcess && !qwenProcess.killed) {
      try { qwenProcess.kill('SIGTERM'); } catch (_) { /* noop */ }
    }
  };

  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stop();
    process.exit(143);
  });
  process.once('exit', stop);
}

function startManagedQwenServer() {
  if (QWEN_RERANKER_URL) {
    qwenState.mode = 'external';
    qwenState.status = 'external';
    qwenState.baseUrl = QWEN_RERANKER_URL;
    return qwenState;
  }

  if (!QWEN_AUTO_START) {
    qwenState.mode = 'disabled';
    qwenState.status = 'disabled';
    return qwenState;
  }

  if (qwenProcess) return qwenState;

  if (!fs.existsSync(QWEN_MODEL_PATH)) {
    qwenState.status = 'missing_model';
    qwenState.lastError = `Model not found: ${QWEN_MODEL_PATH}`;
    console.warn(`\n  Qwen reranker not started: model not found`);
    console.warn(`  Expected GGUF: ${QWEN_MODEL_PATH}`);
    console.warn(`  Tip: any qwen3-reranker*.gguf file in ./models is now auto-detected.`);
    console.warn(`  The viewer will keep using heuristic suggestions.\n`);
    return qwenState;
  }

  if (!QWEN_LLAMA_SERVER_BIN || !executableExists(QWEN_LLAMA_SERVER_BIN)) {
    const expected = qwenExpectedLlamaServerLabel();
    qwenState.status = 'missing_binary';
    qwenState.lastError = `llama-server executable not found: ${expected}`;
    console.warn(`\n  Qwen reranker not started: llama-server executable not found`);
    console.warn(`  Expected binary: ${expected}`);
    if (process.env.QWEN_LLAMA_SERVER_BIN) {
      console.warn(`  Configured QWEN_LLAMA_SERVER_BIN does not exist or is not accessible.`);
    }
    if (QWEN_LLAMA_SERVER_CANDIDATES.length) {
      const shown = QWEN_LLAMA_SERVER_CANDIDATES.slice(0, 12);
      console.warn(`  Tested common locations:`);
      for (const candidate of shown) console.warn(`    - ${candidate}`);
      if (QWEN_LLAMA_SERVER_CANDIDATES.length > shown.length) {
        console.warn(`    - ... ${QWEN_LLAMA_SERVER_CANDIDATES.length - shown.length} more; run "bun run qwen:doctor" for the full diagnosis`);
      }
    }
    console.warn(`  ${qwenSetupTip()}`);
    console.warn(`  The viewer will keep using heuristic suggestions.\n`);
    return qwenState;
  }

  const args = [
    '-m', QWEN_MODEL_PATH,
    '--reranking',
    '--embedding',
    '--pooling', 'rank',
    '--ctx-size', String(QWEN_LLAMA_CONTEXT),
    '--host', QWEN_LLAMA_HOST,
    '--port', String(QWEN_LLAMA_PORT),
  ];

  if (Number.isFinite(QWEN_LLAMA_BATCH) && QWEN_LLAMA_BATCH > 0) {
    args.push('--batch-size', String(QWEN_LLAMA_BATCH));
  }

  if (Number.isFinite(QWEN_LLAMA_UBATCH) && QWEN_LLAMA_UBATCH > 0) {
    args.push('--ubatch-size', String(QWEN_LLAMA_UBATCH));
  }

  if (QWEN_LLAMA_THREADS) {
    args.push('--threads', String(QWEN_LLAMA_THREADS));
  }

  if (QWEN_GPU_LAYERS && QWEN_GPU_LAYERS !== '0') {
    args.push('--n-gpu-layers', QWEN_GPU_LAYERS);
  }

  console.log(`\n  Starting managed Qwen reranker`);
  console.log(`  ─────────────────────────────`);
  console.log(`  ${QWEN_LLAMA_SERVER_BIN} ${args.map((arg) => arg.includes(' ') ? JSON.stringify(arg) : arg).join(' ')}`);

  try {
    qwenProcess = spawn(QWEN_LLAMA_SERVER_BIN, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    qwenState.status = 'failed';
    qwenState.lastError = error.message || String(error);
    console.warn(`  Could not start llama-server: ${qwenState.lastError}`);
    return qwenState;
  }

  qwenState.mode = 'managed';
  qwenState.status = 'starting';
  qwenState.pid = qwenProcess.pid;
  qwenState.startedAt = new Date().toISOString();
  qwenState.lastError = null;

  qwenProcess.stdout.on('data', (chunk) => appendQwenLog(chunk));
  qwenProcess.stderr.on('data', (chunk) => appendQwenLog(chunk));
  qwenProcess.on('error', (error) => {
    qwenState.status = 'failed';
    qwenState.lastError = error.message || String(error);
    console.warn(`  llama-server error: ${qwenState.lastError}`);
    if (String(error?.code || '').toUpperCase() === 'ENOENT') {
      console.warn(`  ${qwenSetupTip()}`);
    }
  });
  qwenProcess.on('exit', (code, signal) => {
    qwenState.status = code === 0 ? 'stopped' : 'failed';
    qwenState.lastError = code === 0 ? null : `llama-server exited with code=${code} signal=${signal || ''}`.trim();
    qwenState.pid = null;
    qwenProcess = null;
    if (code !== 0) console.warn(`  ${qwenState.lastError}`);
  });

  attachQwenShutdownHandlers();
  return qwenState;
}

function splitStepArgs(text) {
  const args = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < String(text || '').length; i++) {
    const char = text[i];

    if (char === "'") {
      current += char;
      if (inString && text[i + 1] === "'") {
        current += text[i + 1];
        i++;
      } else {
        inString = !inString;
      }
      continue;
    }

    if (!inString && char === '(') {
      depth++;
      current += char;
      continue;
    }

    if (!inString && char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (!inString && depth === 0 && char === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) args.push(current.trim());
  return args;
}

function parseStepString(arg) {
  const text = String(arg || '').trim();
  if (!text || text === '$' || text === '*') return '';
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return '';
}

function parseStepRef(arg) {
  const match = String(arg || '').match(/#(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseStepRefs(arg) {
  return [...String(arg || '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function parseIfcEntityMap(ifcText) {
  const entities = new Map();
  const lines = String(ifcText || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)\s*;$/i);
    if (!match) continue;
    const id = Number(match[1]);
    const type = match[2].toUpperCase();
    const argsText = match[3];
    const rawArgs = splitStepArgs(argsText);
    entities.set(id, { id, type, rawArgs, raw: trimmed });
  }

  return entities;
}

function refsFromEntity(entity) {
  if (!entity) return [];
  return parseStepRefs(entity.rawArgs.join(','));
}

function collectReachableEntities(entities, startRefs, maxDepth = 7) {
  const visited = new Set();
  const queue = [];
  for (const ref of startRefs || []) {
    if (Number.isFinite(ref)) queue.push({ id: ref, depth: 0 });
  }

  const out = [];
  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);
    const entity = entities.get(id);
    if (!entity) continue;
    out.push(entity);
    for (const ref of refsFromEntity(entity)) {
      if (!visited.has(ref)) queue.push({ id: ref, depth: depth + 1 });
    }
  }
  return out;
}

function parsePointList3D(entity) {
  if (!entity || entity.type !== 'IFCCARTESIANPOINTLIST3D') return [];
  const numbers = [...String(entity.rawArgs[0] || '').matchAll(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter(Number.isFinite);

  const points = [];
  for (let i = 0; i + 2 < numbers.length; i += 3) {
    points.push([numbers[i], numbers[i + 1], numbers[i + 2]]);
  }
  return points;
}

function parseIndexTriples(arg) {
  const triples = [];
  const groups = String(arg || '').match(/\([^()]*\)/g) || [];
  for (const group of groups) {
    const nums = [...group.matchAll(/\d+/g)].map((m) => Number(m[0]));
    if (nums.length >= 3) triples.push(nums.slice(0, 3));
  }
  return triples;
}

function bboxFromPoints(points) {
  if (!points?.length) return null;

  // Coordinates read from the generated IFC are Z-up because the converter
  // writes glTF Y-up positions as IFC (x, -z, y). The rest of the classifier
  // and the Qwen prompt use the internal GLB-style convention where `sizeY`
  // is the vertical dimension. Normalize the IFC bounds back to that convention
  // here so slabs/columns/walls are not interpreted as rotated by 90°.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], point[i]);
      max[i] = Math.max(max[i], point[i]);
    }
  }

  const ifcSizeX = max[0] - min[0]; // plan X
  const ifcSizeY = max[1] - min[1]; // plan Y, generated from -glTF Z
  const ifcSizeZ = max[2] - min[2]; // vertical, generated from glTF Y

  return {
    coordinateSystem: 'IFC_Z_UP_NORMALIZED_TO_Y_UP',
    verticalAxisInSource: 'Z',
    min,
    max,
    sourceSize: [ifcSizeX, ifcSizeY, ifcSizeZ],
    sourceSizeX: ifcSizeX,
    sourceSizeY: ifcSizeY,
    sourceSizeZ: ifcSizeZ,

    // Normalized dimensions used by the reranker/heuristics:
    // X = plan X, Y = vertical, Z = plan Y.
    size: [ifcSizeX, ifcSizeZ, ifcSizeY],
    sizeX: ifcSizeX,
    sizeY: ifcSizeZ,
    sizeZ: ifcSizeY,
    verticalSize: ifcSizeZ,
    planSizeX: ifcSizeX,
    planSizeY: ifcSizeY,
    horizontal: Math.max(ifcSizeX, ifcSizeY),
    minHoriz: Math.min(ifcSizeX, ifcSizeY),
    planArea: Math.max(0, ifcSizeX) * Math.max(0, ifcSizeY),
    areaXZ: Math.max(0, ifcSizeX) * Math.max(0, ifcSizeY),
  };
}

function faceRatiosFromTriangulatedSets(reachable, pointsByListId) {
  let totalArea = 0;
  let verticalArea = 0;
  let horizontalArea = 0;
  let inclinedArea = 0;

  for (const entity of reachable) {
    if (entity.type !== 'IFCTRIANGULATEDFACESET') continue;
    const pointListId = parseStepRef(entity.rawArgs[0]);
    const points = pointsByListId.get(pointListId) || [];
    const coordIndex = parseIndexTriples(entity.rawArgs[2]);
    if (!points.length || !coordIndex.length) continue;

    for (const tri of coordIndex) {
      const a = points[tri[0] - 1];
      const b = points[tri[1] - 1];
      const c = points[tri[2] - 1];
      if (!a || !b || !c) continue;

      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen < 1e-9) continue;

      const area = nLen / 2;
      // The generated IFC is Z-up. A horizontal face has a mostly vertical
      // normal, therefore abs(normal.z) is high. The previous version used
      // abs(normal.y), which made vertical columns look like flat slabs.
      const anz = Math.abs(nz / nLen);
      totalArea += area;
      if (anz < 0.35) verticalArea += area;
      if (anz > 0.75) horizontalArea += area;
      if (anz >= 0.25 && anz <= 0.95) inclinedArea += area;
    }
  }

  if (totalArea <= 0) return null;
  return {
    verticalFaces: verticalArea / totalArea,
    horizontalFaces: horizontalArea / totalArea,
    inclinedFaces: inclinedArea / totalArea,
  };
}

function extractIfcElementFeatures(ifcText, localId, currentTypeHint = '') {
  const entities = parseIfcEntityMap(ifcText);
  const entity = entities.get(Number(localId));
  if (!entity) throw new Error(`Entité IFC #${localId} introuvable.`);

  const name = parseStepString(entity.rawArgs[2]);
  const objectType = parseStepString(entity.rawArgs[4]);
  const representationId = parseStepRef(entity.rawArgs[6]);
  const tag = parseStepString(entity.rawArgs[7]);
  const currentType = String(currentTypeHint || entity.type || '').toUpperCase();

  const startRefs = representationId ? [representationId] : refsFromEntity(entity);
  const reachable = collectReachableEntities(entities, startRefs, 8);
  const pointsByListId = new Map();
  const allPoints = [];

  for (const refEntity of reachable) {
    if (refEntity.type !== 'IFCCARTESIANPOINTLIST3D') continue;
    const points = parsePointList3D(refEntity);
    if (!points.length) continue;
    pointsByListId.set(refEntity.id, points);
    allPoints.push(...points);
  }

  const bbox = bboxFromPoints(allPoints);
  let ratios = faceRatiosFromTriangulatedSets(reachable, pointsByListId);

  if (!ratios && bbox) {
    const thin = bbox.minHoriz <= Math.max(0.08, bbox.horizontal * 0.12);
    const flat = bbox.sizeY <= Math.max(0.12, bbox.horizontal * 0.08);
    const tall = bbox.sizeY >= Math.max(1.0, bbox.horizontal * 0.35);
    ratios = {
      verticalFaces: tall || thin ? 0.65 : 0.25,
      horizontalFaces: flat ? 0.65 : 0.25,
      inclinedFaces: 0,
    };
  }

  const searchable = normalizeText([name, objectType, tag, currentType].join(' '));
  const hints = {
    hasWallHint: /\b(wall|walls|mur|murs|cloison|partition|facade|facades)\b/.test(searchable),
    hasDoorHint: /\b(door|doors|porte|portes|ouvrant|battant)\b/.test(searchable),
    hasWindowHint: /\b(window|windows|fenetre|fenetres|vitre|vitrage|glass|glazing|baie)\b/.test(searchable),
    hasSlabHint: /\b(slab|floor|floors|plancher|dalle|ceiling|plafond)\b/.test(searchable),
    hasRoofHint: /\b(roof|roofs|toit|toits|toiture|couverture)\b/.test(searchable),
    hasBeamHint: /\b(beam|beams|poutre|poutres|joist|lintel|linteau|ipe|hea|heb|ipn)\b/.test(searchable),
    hasColumnHint: /\b(column|columns|pillar|post|colonne|poteau|poteaux|pilier)\b/.test(searchable),
    hasStairHint: /\b(stair|stairs|escalier|escaliers|marche|marches|volee|volée)\b/.test(searchable),
    hasFurnitureHint: /\b(furniture|furnishing|mobilier|table|chair|chaise|cabinet|armoire)\b/.test(searchable),
    hasMepHint: /\b(pipe|tube|tuyau|duct|gaine|cable|wire|fil|ventilation|cvc|hvac|mep|plumbing|sanitary|wc|toilet|lavabo|sink|luminaire|light)\b/.test(searchable),
  };

  return {
    localId: Number(localId),
    currentType,
    originalType: entity.type,
    name,
    objectType,
    tag,
    bbox,
    ratios: ratios || { verticalFaces: 0, horizontalFaces: 0, inclinedFaces: 0 },
    hints,
    geometryPointCount: allPoints.length,
  };
}

function aliasScoreForEntry(entry, features) {
  const text = normalizeText([features.name, features.objectType, features.tag, features.currentType].join(' '));
  let score = 0;
  for (const alias of entry.aliases || []) {
    const a = normalizeText(alias);
    if (!a) continue;
    if (text === a || text.includes(` ${a} `) || text.startsWith(`${a} `) || text.endsWith(` ${a}`)) score = Math.max(score, 1);
    else if (text.includes(a)) score = Math.max(score, 0.65);
  }
  const typeBody = normalizeText(String(entry.type || '').replace(/^IFC/i, ''));
  if (typeBody && text.includes(typeBody)) score = Math.max(score, 0.85);
  return score;
}

function heuristicScoreForIfcType(entry, features) {
  const type = String(entry.type || '').toUpperCase();
  const b = features.bbox || {};
  const r = features.ratios || {};
  const h = features.hints || {};
  const sx = Math.abs(b.sizeX || 0);
  const sy = Math.abs(b.sizeY || 0);
  const sz = Math.abs(b.sizeZ || 0);
  const horizontal = Math.max(sx, sz);
  const minHoriz = Math.min(sx || Infinity, sz || Infinity);
  const thinness = horizontal > 0 ? minHoriz / horizontal : 1;
  const verticalFaces = r.verticalFaces || 0;
  const horizontalFaces = r.horizontalFaces || 0;
  const inclinedFaces = r.inclinedFaces || 0;
  const alias = aliasScoreForEntry(entry, features);

  let score = 0.08 + alias * 0.24;

  if (type === features.currentType) score += 0.04;
  if (entry.tier === 'unsupported') score -= 0.5;

  switch (type) {
    case 'IFCWALL':
      score += (h.hasWallHint ? 0.35 : 0) + (sy >= 1.6 ? 0.18 : 0) + (thinness <= 0.18 ? 0.18 : 0) + (verticalFaces >= 0.45 ? 0.16 : 0);
      if (h.hasDoorHint || h.hasWindowHint || h.hasSlabHint) score -= 0.25;
      break;
    case 'IFCCURTAINWALL':
      score += ((h.hasWallHint || h.hasWindowHint) ? 0.22 : 0) + (sy >= 1.8 ? 0.15 : 0) + (thinness <= 0.18 ? 0.12 : 0) + (verticalFaces >= 0.45 ? 0.12 : 0);
      break;
    case 'IFCPLATE':
      score += (thinness <= 0.10 ? 0.28 : 0) + ((h.hasWindowHint || h.hasWallHint) ? 0.12 : 0) + (Math.max(verticalFaces, horizontalFaces) >= 0.5 ? 0.10 : 0);
      break;
    case 'IFCSLAB':
      score += (h.hasSlabHint ? 0.35 : 0) + (sy <= 0.65 && horizontal >= 0.8 ? 0.22 : 0) + (horizontalFaces >= 0.45 ? 0.18 : 0);
      if (h.hasWallHint || h.hasDoorHint || h.hasWindowHint) score -= 0.22;
      break;
    case 'IFCROOF':
      score += (h.hasRoofHint ? 0.36 : 0) + (inclinedFaces >= 0.18 ? 0.22 : 0) + (horizontalFaces >= 0.45 && horizontal >= 1.2 ? 0.12 : 0);
      break;
    case 'IFCDOOR':
      score += (h.hasDoorHint ? 0.45 : 0) + (sy >= 1.5 && sy <= 2.8 ? 0.18 : 0) + (minHoriz <= 0.35 ? 0.12 : 0) + (verticalFaces >= 0.35 ? 0.10 : 0);
      if (h.hasWindowHint && !h.hasDoorHint) score -= 0.24;
      break;
    case 'IFCWINDOW':
      score += (h.hasWindowHint ? 0.45 : 0) + (sy >= 0.35 && sy <= 2.8 ? 0.13 : 0) + (minHoriz <= 0.35 ? 0.12 : 0) + (verticalFaces >= 0.35 ? 0.10 : 0);
      if (h.hasDoorHint && !h.hasWindowHint) score -= 0.20;
      break;
    case 'IFCBEAM':
      score += (h.hasBeamHint ? 0.42 : 0) + (horizontal >= Math.max(1.0, sy * 2.0) ? 0.20 : 0) + (minHoriz <= 0.8 ? 0.10 : 0);
      if (h.hasWallHint && sy >= 1.6) score -= 0.22;
      break;
    case 'IFCCOLUMN':
      score += (h.hasColumnHint ? 0.42 : 0) + (sy >= 1.2 ? 0.18 : 0) + (horizontal <= 1.4 ? 0.14 : 0) + (thinness >= 0.35 ? 0.08 : 0);
      if (h.hasWallHint && horizontal > 1.5) score -= 0.25;
      break;
    case 'IFCSTAIR':
    case 'IFCSTAIRFLIGHT':
      score += (h.hasStairHint ? 0.46 : 0) + (sy >= 0.35 && horizontal >= 0.8 ? 0.14 : 0) + (horizontalFaces >= 0.25 ? 0.08 : 0);
      break;
    case 'IFCRAILING':
      score += (/railing|garde|handrail|main courante/i.test(`${features.name} ${features.objectType}`) ? 0.46 : 0) + (horizontal >= 0.8 && sy >= 0.4 && sy <= 1.4 ? 0.14 : 0);
      break;
    case 'IFCFURNISHINGELEMENT':
      score += (h.hasFurnitureHint ? 0.46 : 0) + (!h.hasWallHint && !h.hasSlabHint && !h.hasDoorHint && !h.hasWindowHint && sy < 2.4 ? 0.10 : 0);
      break;
    case 'IFCSANITARYTERMINAL':
    case 'IFCLIGHTFIXTURE':
    case 'IFCFLOWTERMINAL':
    case 'IFCDUCTSEGMENT':
    case 'IFCPIPESEGMENT':
    case 'IFCCABLESEGMENT':
      score += (h.hasMepHint ? 0.34 : 0) + alias * 0.20;
      break;
    case 'IFCBUILDINGELEMENTPROXY':
      score += 0.18;
      if (alias > 0.2 || h.hasWallHint || h.hasSlabHint || h.hasDoorHint || h.hasWindowHint || h.hasBeamHint || h.hasColumnHint || h.hasRoofHint) score -= 0.12;
      break;
    default:
      score += alias * 0.20;
  }

  return clamp01(score);
}

function buildCandidateEntries(features, maxCandidates = 80) {
  const supported = IFC_TYPES.filter((entry) =>
    entry.tier !== 'unsupported' &&
    !QWEN_EXCLUDED_TARGET_TYPES.has(entry.type)
  );

  // The assistant is mainly used to replace generic proxies with a real IFC
  // family. Keep the current type in the context, but do not rank
  // IFCBUILDINGELEMENTPROXY as a target class unless explicitly enabled with
  // QWEN_ALLOW_PROXY_TARGET=1.
  const required = new Set([
    features.currentType,
    'IFCWALL',
    'IFCSLAB',
    'IFCDOOR',
    'IFCWINDOW',
    'IFCROOF',
    'IFCPLATE',
    'IFCBEAM',
    'IFCCOLUMN',
    'IFCSTAIR',
  ]
    .filter(Boolean)
    .filter((type) => !QWEN_EXCLUDED_TARGET_TYPES.has(type)));

  const ranked = supported
    .map((entry) => ({ entry, score: heuristicScoreForIfcType(entry, features), required: required.has(entry.type) }))
    .sort((a, b) => (b.required - a.required) || b.score - a.score);

  const out = [];
  const seen = new Set();
  for (const item of ranked) {
    if (seen.has(item.entry.type)) continue;
    if (QWEN_EXCLUDED_TARGET_TYPES.has(item.entry.type)) continue;
    // V10: send the full requested candidate pool to the reranker.
    // Earlier versions stopped around 18 low-heuristic entries, which made
    // Qwen repeatedly see the same small set even when the catalog had ~80
    // applicable targets. maxCandidates still bounds latency.
    out.push(item.entry);
    seen.add(item.entry.type);
    if (out.length >= maxCandidates) break;
  }
  return out;
}

function compactNumber(value, digits = 3) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function trueHintNames(hints = {}) {
  return Object.entries(hints)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key.replace(/^has/, '').replace(/Hint$/, '').toLowerCase());
}

function buildRerankerQuery(features) {
  const b = features.bbox || {};
  const r = features.ratios || {};
  const compact = {
    id: features.localId,
    currentType: features.currentType,
    sourceType: features.originalType,
    name: features.name || '',
    objectType: features.objectType || '',
    tag: features.tag || '',
    axes: 'IFC source is Z-up; values below are normalized: height=sizeY, plan=sizeX/sizeZ',
    bbox: b ? {
      sizeX: compactNumber(b.sizeX),
      sizeY_height: compactNumber(b.sizeY),
      sizeZ: compactNumber(b.sizeZ),
      planLong: compactNumber(b.horizontal),
      planShort: compactNumber(b.minHoriz),
      planArea: compactNumber(b.planArea),
    } : null,
    faceRatios: {
      vertical: compactNumber(r.verticalFaces, 2),
      horizontal: compactNumber(r.horizontalFaces, 2),
      inclined: compactNumber(r.inclinedFaces, 2),
    },
    trueHints: trueHintNames(features.hints),
  };

  return [
    'Rank the candidate IFC class for this BIM mesh.',
    'Use physical semantics, name hints and geometry. A current proxy means unknown source; do not choose proxy as target.',
    'Axes: normalized Y-up; sizeY_height is vertical height; sizeX/sizeZ are plan dimensions.',
    `Element=${JSON.stringify(compact)}`,
    'Question: is the candidate IFC type a good match?',
  ].join('\n');
}

function normalizeRerankScores(results, count) {
  const scores = new Array(count).fill(null);
  for (const result of results || []) {
    const index = Number(result.index ?? result.document_index ?? result.id);
    const score = Number(result.relevance_score ?? result.score ?? result.logit ?? result.value);
    if (Number.isInteger(index) && index >= 0 && index < count && Number.isFinite(score)) scores[index] = score;
  }

  const finite = scores.filter(Number.isFinite);
  if (!finite.length) return null;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return scores.map((score) => {
    if (!Number.isFinite(score)) return 0;
    if (score >= 0 && score <= 1 && min >= 0 && max <= 1) return score;
    if (Math.abs(max - min) < 1e-9) return 0.5;
    return (score - min) / (max - min);
  });
}

function extractRerankResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.scores)) return payload.scores.map((score, index) => ({ index, score }));
  return [];
}

async function postJsonWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* keep text */ }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function getWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForManagedQwenServerReady(timeoutMs = QWEN_STARTUP_TIMEOUT_MS) {
  if (QWEN_RERANKER_URL || !QWEN_AUTO_START) return true;

  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${QWEN_LLAMA_BASE_URL}/health`;

  while (Date.now() < deadline) {
    if (qwenState.status === 'failed') {
      try {
        const response = await getWithTimeout(healthUrl, 1500);
        if (response.ok) {
          qwenState.status = 'ready';
          return true;
        }
      } catch (_) {
        throw new Error(qwenState.lastError || 'llama-server failed to start');
      }
    }

    try {
      const response = await getWithTimeout(healthUrl, 1500);
      if (response.ok) {
        qwenState.status = 'ready';
        return true;
      }
    } catch (_) {
      // Server is still booting or not listening yet.
    }

    await sleep(750);
  }

  throw new Error(`llama-server not ready after ${timeoutMs}ms`);
}

async function callQwenReranker(query, documents) {
  if (!QWEN_RERANKER_URL && QWEN_AUTO_START && ['not_started', 'stopped'].includes(qwenState.status)) {
    startManagedQwenServer();
  }

  if (!QWEN_RERANKER_URL && QWEN_AUTO_START && ['starting', 'failed'].includes(qwenState.status)) {
    await waitForManagedQwenServerReady();
  }

  const urls = QWEN_RERANKER_URL ? [QWEN_RERANKER_URL] : DEFAULT_QWEN_RERANKER_URLS;
  const payload = { query, documents };
  let lastError = null;

  for (const url of urls) {
    try {
      const json = await postJsonWithTimeout(url, payload, QWEN_RERANK_TIMEOUT_MS);
      const results = extractRerankResults(json);
      const scores = normalizeRerankScores(results, documents.length);
      if (!scores) throw new Error('Réponse reranker sans scores exploitables.');
      return { scores, endpoint: url };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Qwen reranker indisponible.');
}

function reasonCodesForSuggestion(type, features) {
  const h = features.hints || {};
  const b = features.bbox || {};
  const r = features.ratios || {};
  const reasons = [];
  if (h.hasWallHint && ['IFCWALL', 'IFCCURTAINWALL', 'IFCPLATE'].includes(type)) reasons.push('name_hint_wall');
  if (h.hasDoorHint && type === 'IFCDOOR') reasons.push('name_hint_door');
  if (h.hasWindowHint && type === 'IFCWINDOW') reasons.push('name_hint_window_or_glass');
  if (h.hasSlabHint && type === 'IFCSLAB') reasons.push('name_hint_slab');
  if (h.hasRoofHint && type === 'IFCROOF') reasons.push('name_hint_roof');
  if (h.hasBeamHint && type === 'IFCBEAM') reasons.push('name_hint_beam');
  if (h.hasColumnHint && type === 'IFCCOLUMN') reasons.push('name_hint_column');
  if (h.hasStairHint && type.startsWith('IFCSTAIR')) reasons.push('name_hint_stair');
  if (b.sizeY >= 1.6 && b.minHoriz <= Math.max(0.35, b.horizontal * 0.18)) reasons.push('thin_vertical_bbox');
  if (b.sizeY <= 0.65 && b.horizontal >= 0.8) reasons.push('flat_horizontal_bbox');
  if ((r.verticalFaces || 0) >= 0.45) reasons.push('vertical_faces_high');
  if ((r.horizontalFaces || 0) >= 0.45) reasons.push('horizontal_faces_high');
  if ((r.inclinedFaces || 0) >= 0.18) reasons.push('inclined_faces_present');
  if (!reasons.length) reasons.push('semantic_rerank_match');
  return reasons.slice(0, 4);
}

function safeFeaturePreview(features) {
  return {
    localId: features.localId,
    currentType: features.currentType,
    name: features.name,
    objectType: features.objectType,
    tag: features.tag,
    bbox: features.bbox ? {
      coordinateSystem: features.bbox.coordinateSystem,
      verticalAxisInSource: features.bbox.verticalAxisInSource,
      sizeX: features.bbox.sizeX,
      sizeY: features.bbox.sizeY,
      sizeZ: features.bbox.sizeZ,
      verticalSize: features.bbox.verticalSize,
      horizontal: features.bbox.horizontal,
      minHoriz: features.bbox.minHoriz,
      planArea: features.bbox.planArea,
      sourceSizeX: features.bbox.sourceSizeX,
      sourceSizeY: features.bbox.sourceSizeY,
      sourceSizeZ: features.bbox.sourceSizeZ,
    } : null,
    ratios: features.ratios,
    hints: features.hints,
    geometryPointCount: features.geometryPointCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP endpoint
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/convert', upload.single('glb'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const glbPath = req.file.path;
  const originalName = req.file.originalname;

  try {
    console.log(`[${new Date().toISOString()}] Processing ${originalName}`);

    const meshes = await extractMeshesFromGLB(glbPath);
    console.log(`  Extracted ${meshes.length} meshes`);
    const manualSpaceCount = meshes.filter(isManualSpaceMesh).length;
    if (manualSpaceCount > 0) {
      console.log(`  Manual/generated IFC space overlay meshes: ${manualSpaceCount}`);
    }
    if (meshes.length === 0) throw new Error('No meshes found in GLB file');

    const scaleInfo = normalizeMeshUnits(meshes);
    if (scaleInfo.applied) {
      console.log(`  Input scale normalization: ${scaleInfo.assumedInputUnit} → metre (x${scaleInfo.scale})`);
      console.log(`  Scale reason: ${scaleInfo.reason}`);
    } else {
      console.log(`  Input scale normalization: none (${scaleInfo.reason})`);
    }

    for (const mesh of meshes) {
      mesh.classification = isManualSpaceMesh(mesh) ? 'space' : classifyMeshFirstPass(mesh);
    }

    const physicalMeshes = meshes.filter(mesh => !isManualSpaceMesh(mesh));

    // First detect preliminary storeys, then use them to decide whether a thin
    // element starts at floor level (door) or above it (window). Re-run storey
    // detection after refinement so reclassified opening panels do not pollute
    // the wall-base fallback. Manual IfcSpace overlays are excluded from this
    // structural detection pass because they are spatial volumes, not building
    // elements.
    let storeys = detectStoreys(physicalMeshes);
    refineOpenings(physicalMeshes, storeys);
    storeys = detectStoreys(physicalMeshes);
    assignStoreys(meshes, storeys);

    const roofRefinement = refineRoofs(physicalMeshes, storeys);
    if (roofRefinement.promoted > 0) {
      storeys = detectStoreys(physicalMeshes);
      assignStoreys(meshes, storeys);
    }

    markExternalWalls(physicalMeshes, storeys);
    console.log(`  Detected ${storeys.length} storey(s) at elevations: ${storeys.map(s => s.elevation.toFixed(2)).join(', ')}`);
    for (const storey of storeys) {
      const confidence = storey.confidence != null ? ` confidence=${storey.confidence.toFixed(2)}` : '';
      const sources = storey.sourceSummary ? ` sources=[${storey.sourceSummary}]` : '';
      console.log(`    - ${storey.name}: ${storey.elevation.toFixed(2)}m${confidence}${sources}`);
    }
    if (storeys.ignoredCandidates && storeys.ignoredCandidates.length > 0) {
      const preview = storeys.ignoredCandidates.slice(0, 8)
        .map(c => `${c.elevation.toFixed(2)}m:${c.reason}`)
        .join(', ');
      console.log(`  Ignored storey candidate(s): ${preview}${storeys.ignoredCandidates.length > 6 ? '...' : ''}`);
    }

    const externalWalls = meshes.filter(m => m.classification === 'wall' && m.isExternal).length;
    console.log(`  Detected ${externalWalls} external wall(s)`);

    const { content, stats, storeyCount } = generateIFC(meshes, storeys, originalName, scaleInfo);
    console.log(`  Classified: ${stats.wall} walls, ${stats.slab} slabs, ${stats.beam} beams, ${stats.column} columns, ${stats.stair} stairs, ${stats.roof} roofs, ${stats.door} doors, ${stats.window} windows, ${stats.proxy} proxies`);
    if (stats.inputScaleApplied) {
      console.log(`  IFC unit normalization: ${stats.assumedInputUnit} → ${stats.outputUnit}, x${stats.inputScale}`);
      console.log(`  Max dimension: ${stats.originalMaxDimension.toFixed(2)} → ${stats.normalizedMaxDimension.toFixed(2)} m`);
    }
    console.log(`  Pset_WallCommon IsExternal=true on ${stats.externalWall || 0} wall(s)`);
    if (stats.quantities != null) {
      console.log(`  IFC quantity sets: ${stats.quantities || 0}`);
    }
    console.log(`  IFC materials: ${stats.materials || 0}`);
    console.log(`  IFC spaces: ${stats.spaces || 0}`);
    if (stats.manualSpaces > 0) {
      console.log(`  Manual/edited IFC spaces: ${stats.manualSpaces}`);
    }
    console.log(`  IFC zones: ${stats.zones || 0}`);
    console.log(`  Room prototype spaces: ${stats.roomPrototypeSpaces || 0}`);
    console.log(`  Sloped roof spaces: ${stats.slopedRoofSpaces || 0}`);
    console.log(`  Beam-guided roof spaces: ${stats.beamGuidedRoofSpaces || 0}`);
    console.log(`  IfcRelSpaceBoundary: ${stats.spaceBoundaries || 0}`);
    console.log(`  Open room-cell merge: enabled`);
    console.log(`  Space wall snapping: enabled`);
    console.log(`  Space wall clamp: enabled`);
    console.log(`  Strong wall clamp: enabled`);
    console.log(`  Tiny space filter: enabled`);
    console.log(`  IFC presentation layers: ${stats.layers || 0}`);
    if (stats.layers > 0 && stats.layerNames) {
      const layerPreview = Object.entries(stats.layerNames)
        .map(([name, count]) => `${name}: ${count}`)
        .join(', ');
      console.log(`  Presentation layers: ${layerPreview}`);
    }
    if (stats.materials > 0 && stats.materialNames) {
      const materialPreview = Object.entries(stats.materialNames)
        .slice(0, 8)
        .map(([name, count]) => `${name}: ${count}`)
        .join(', ');
      console.log(`  Material associations: ${materialPreview}${Object.keys(stats.materialNames).length > 8 ? '...' : ''}`);
    }
    console.log(`  IFC quantity sets: ${stats.quantities || 0}`);
    console.log(`  Applied fallback colors on ${stats.fallbackColors || 0} element(s)`);
    if (stats.uniformatCodes > 0) {
      const uniformatPreview = Object.entries(stats.uniformat)
        .map(([code, info]) => `${code} ${info.name}: ${info.count}`)
        .join(', ');
      console.log(`  Uniformat classifications: ${uniformatPreview}`);
    }

    const outputName = originalName.replace(/\.glb$/i, '') + '.ifc';

    res.setHeader('Content-Type', 'application/x-step');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('X-Conversion-Stats', JSON.stringify({ ...stats, total: meshes.length, storeys: storeyCount }));
    res.send(content);

  } catch (err) {
    console.error('Conversion error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(glbPath, () => {});
  }
});

app.post('/api/qwen-suggest', async (req, res) => {
  const { ifcText, localId, currentType, maxSuggestions = 3, maxCandidates = 80 } = req.body || {};

  if (!ifcText || typeof ifcText !== 'string') {
    return res.status(400).json({ error: 'Missing ifcText' });
  }
  if (!Number.isFinite(Number(localId))) {
    return res.status(400).json({ error: 'Missing or invalid localId' });
  }

  try {
    const features = extractIfcElementFeatures(ifcText, Number(localId), currentType);
    const candidates = buildCandidateEntries(features, Math.max(8, Math.min(160, Number(maxCandidates) || 80)));
    const query = buildRerankerQuery(features);
    const documents = candidates.map(candidateDocumentForIfcType);

    let qwenScores = null;
    let qwenEndpoint = null;
    let qwenError = null;

    try {
      const rerank = await callQwenReranker(query, documents);
      qwenScores = rerank.scores;
      qwenEndpoint = rerank.endpoint;
    } catch (error) {
      qwenError = error.message || String(error);
      console.warn(`Qwen reranker unavailable, using heuristic fallback: ${qwenError}`);
    }

    const suggestions = candidates
      .map((entry, index) => {
        const heuristicScore = heuristicScoreForIfcType(entry, features);
        const qwenScore = qwenScores ? clamp01(qwenScores[index]) : null;
        const finalScore = qwenScore == null
          ? heuristicScore
          : clamp01(0.65 * qwenScore + 0.35 * heuristicScore);
        return {
          type: entry.type,
          label: entry.label,
          category: entry.category,
          tier: entry.tier,
          predefined: entry.predefined,
          score: Number(finalScore.toFixed(4)),
          qwenScore: qwenScore == null ? null : Number(qwenScore.toFixed(4)),
          heuristicScore: Number(heuristicScore.toFixed(4)),
          reasonCodes: reasonCodesForSuggestion(entry.type, features),
        };
      })
      .filter((suggestion) => suggestion.tier !== 'unsupported')
      .filter((suggestion) => !QWEN_EXCLUDED_TARGET_TYPES.has(suggestion.type))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(10, Number(maxSuggestions) || 3)));

    res.json({
      localId: Number(localId),
      currentType: features.currentType,
      llmAvailable: Boolean(qwenScores),
      qwenEndpoint,
      qwenError,
      qwenRuntime: qwenRuntimeStatus(),
      features: safeFeaturePreview(features),
      candidateCount: candidates.length,
      candidateTypes: candidates.map((candidate) => candidate.type),
      excludedTargetTypes: [...QWEN_EXCLUDED_TARGET_TYPES],
      suggestions,
    });
  } catch (error) {
    console.error('Qwen suggest error:', error);
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.get('/api/qwen-status', (req, res) => {
  res.json(qwenRuntimeStatus());
});

app.post('/api/reexport', async (req, res) => {
  const { ifcText, edits, fileName } = req.body || {};

  if (!ifcText || typeof ifcText !== 'string') {
    return res.status(400).json({ error: 'Missing ifcText' });
  }
  if (!Array.isArray(edits)) {
    return res.status(400).json({ error: 'Missing or invalid edits array' });
  }

  try {
    console.log(`[${new Date().toISOString()}] Reexport with ${edits.length} edit(s)`);
    const result = applyReclassifications(ifcText, edits);
    console.log(`  Applied ${result.applied}/${edits.length} edit(s)`);
    if (result.errors.length > 0) {
      console.log(`  Errors:`, result.errors);
    }

    const outputName = (fileName || 'edited.ifc').replace(/\.ifc$/i, '') + '.edited.ifc';

    res.setHeader('Content-Type', 'application/x-step');
    res.setHeader('Content-Disposition', `attachment; filename="${outputName}"`);
    res.setHeader('X-Edits-Applied', String(result.applied));
    res.setHeader('X-Edits-Errors', String(result.errors.length));
    res.send(result.ifcText);

  } catch (err) {
    console.error('Reexport error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ifc-catalog', (req, res) => {
  res.json({
    types: IFC_TYPES,
    categories: IFC_CATEGORIES,
  });
});

app.get('/api/reclassifiable-types', (req, res) => {
  res.json({ types: reclassifiableTypeNames() });
});

startManagedQwenServer();

app.listen(PORT, () => {
  console.log(`\n  GLB → IFC converter`);
  console.log(`  ───────────────────`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
