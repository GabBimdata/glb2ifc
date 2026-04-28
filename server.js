import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3737;

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

['uploads', 'outputs'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.use(express.static(path.join(__dirname, 'public')));

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

function extractMaterialInfo(primitive) {
  const material = primitive.getMaterial();
  if (!material) {
    return { color: null, materialName: '', opacity: 1 };
  }

  const base = material.getBaseColorFactor() || [1, 1, 1, 1];
  return {
    color: { r: base[0], g: base[1], b: base[2] },
    materialName: material.getName() || '',
    opacity: base[3] ?? 1
  };
}

async function extractMeshesFromGLB(glbPath) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(glbPath);
  const root = document.getRoot();

  const extracted = [];

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const worldMatrix = node.getWorldMatrix();

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
        name: node.getName() || mesh.getName() || 'unnamed',
        positions: transformed,
        indices: Array.from(indices),
        bbox: computeBoundingBox(transformed),
        ...materialInfo
      });
    }
  }

  return extracted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mesh classification
// ─────────────────────────────────────────────────────────────────────────────

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
  const f = triangleFaceAnalysis(mesh);
  const levels = horizontalFaceLevels(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh) || hasBeamHint(mesh) || hasRoofHint(mesh)) return false;

  const namedStair = hasStairHint(mesh) && s.horizontal >= 0.45 && s.sizeY >= 0.08;

  // A full stair mesh often has many horizontal treads at different altitudes.
  // This is deliberately conservative to avoid classifying shelves, façades or
  // decorative stepped roofs as stairs.
  const repeatedTreads =
    levels.count >= 4 &&
    levels.ySpan >= 0.35 &&
    levels.avgGap >= 0.07 &&
    levels.avgGap <= 0.35 &&
    s.horizontal >= 0.9 &&
    s.sizeY >= 0.35 &&
    s.sizeY <= 5.5 &&
    s.areaXZ >= 0.6 &&
    s.areaXZ <= 60 &&
    f.horizontalRatio >= 0.18 &&
    f.verticalRatio <= 0.82;

  const stairSlope = s.sizeY / Math.max(s.horizontal, 0.001);
  const plausibleSlope = stairSlope >= 0.08 && stairSlope <= 1.4;

  if (namedStair || (repeatedTreads && plausibleSlope)) {
    mesh.stairDetectionReason = namedStair ? 'named_stair' : 'repeated_horizontal_treads';
    return true;
  }

  return false;
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


function looksLikeBeam(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh) || hasRoofHint(mesh) || hasColumnHint(mesh) || hasStairHint(mesh)) return false;

  const length = s.horizontal;
  const width = s.minHoriz;
  const height = s.sizeY;

  // Named beams are strong signals, but still require plausible dimensions.
  const namedBeam = hasBeamHint(mesh) && length >= 0.5 && height >= 0.05 && height <= 1.2 && width <= 1.2;

  // Generic beams: elongated, horizontal, modest cross-section, with enough
  // vertical side faces to avoid classifying paper-thin strips or floor slabs.
  const elongated = length >= 1.0 && length / Math.max(width, height, 0.001) >= 3.0;
  const crossSectionOk = width >= 0.04 && width <= 0.9 && height >= 0.08 && height <= 0.9;
  const notHugePanel = s.areaXZ <= Math.max(12, length * 1.2);
  const hasBeamFaces = f.verticalRatio >= 0.25;

  if (namedBeam || (elongated && crossSectionOk && notHugePanel && hasBeamFaces)) {
    mesh.beamDetectionReason = namedBeam ? 'named_beam' : 'elongated_horizontal_member';
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

  // Facade-like objects can have a large bounding box on both X and Z because
  // several exterior wall segments are merged into one mesh. They still have a
  // strong vertical-face signature and relatively little horizontal area.
  const facadeLike =
    f.verticalRatio >= 0.55 &&
    f.horizontalRatio <= 0.35 &&
    s.sizeY >= 1.8 &&
    s.horizontal >= 1.2;

  // Helpful for exports where walls are explicitly named but not geometrically
  // thin because trims/cladding/opening returns are merged into the same mesh.
  const namedWall = hasWallHint(mesh) && f.verticalRatio >= 0.3 && s.sizeY >= 1.2;

  if (thinWall) {
    mesh.wallDetectionReason = 'thin_wall';
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

function classifyMeshFirstPass(mesh) {
  const s = bboxStats(mesh);

  // Strong name/material hints first.
  if ((hasDoorHint(mesh) || hasWindowHint(mesh)) && s.minHoriz < 0.7) return 'proxy';

  if (hasRoofHint(mesh) && looksLikeRoofCandidate(mesh)) {
    mesh.isExternal = true;
    return 'roof';
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

    if (!hostWall) continue;

    const floorY = floorForY(s.minY, storeys).elevation;
    const bottomOffset = s.minY - floorY;

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

function generateIFC(meshes, storeys, originalFilename) {
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
  function getOrCreateStyle(color) {
    if (!color) return null;
    const key = `${color.r.toFixed(3)},${color.g.toFixed(3)},${color.b.toFixed(3)}`;
    if (styleCache.has(key)) return styleCache.get(key);

    const colourRgb = nextId();
    lines.push(`${colourRgb}=IFCCOLOURRGB($,${color.r.toFixed(4)},${color.g.toFixed(4)},${color.b.toFixed(4)});`);
    const surfShading = nextId();
    lines.push(`${surfShading}=IFCSURFACESTYLESHADING(${colourRgb},$);`);
    const surfStyle = nextId();
    lines.push(`${surfStyle}=IFCSURFACESTYLE($,.BOTH.,(${surfShading}));`);
    const presStyle = nextId();
    lines.push(`${presStyle}=IFCPRESENTATIONSTYLEASSIGNMENT((${surfStyle}));`);

    const ref = { presStyle };
    styleCache.set(key, ref);
    return ref;
  }

  function addPropertySingleValue(name, typedValue) {
    const prop = nextId();
    lines.push(`${prop}=IFCPROPERTYSINGLEVALUE('${escapeIFCString(name)}',$,${typedValue},$);`);
    return prop;
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

  // Build elements grouped by storey
  const elementsByStorey = Array.from({ length: storeys.length }, () => []);
  const stats = { wall: 0, slab: 0, beam: 0, column: 0, stair: 0, roof: 0, door: 0, window: 0, proxy: 0, externalWall: 0 };

  const nameCounters = { wall: 0, slab: 0, beam: 0, column: 0, stair: 0, roof: 0, door: 0, window: 0, proxy: 0 };
  const nameLabels = {
    wall: 'Wall',
    slab: 'Slab',
    beam: 'Beam',
    column: 'Column',
    stair: 'Stair',
    roof: 'Roof',
    door: 'Door',
    window: 'Window',
    proxy: 'Proxy'
  };

  function generatedElementName(mesh) {
    const key = Object.prototype.hasOwnProperty.call(nameCounters, mesh.classification)
      ? mesh.classification
      : 'proxy';

    nameCounters[key] += 1;
    return `${nameLabels[key]} ${String(nameCounters[key]).padStart(3, '0')}`;
  }

  for (const mesh of meshes) {
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

    // Apply color via IfcStyledItem
    const style = getOrCreateStyle(mesh.color);
    if (style) {
      lines.push(`${nextId()}=IFCSTYLEDITEM(${faceSet},(${style.presStyle}),$);`);
    }

    const shapeRep = nextId();
    lines.push(`${shapeRep}=IFCSHAPEREPRESENTATION(${styleContext},'Body','Tessellation',(${faceSet}));`);
    const productShape = nextId();
    lines.push(`${productShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}));`);

    const placement = nextId();
    const storeyPlacement = storeyPlacements[mesh.storeyIndex];
    lines.push(`${placement}=IFCLOCALPLACEMENT(${storeyPlacement},${axis});`);

    const elemId = nextId();
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

    queueUniformatAssociation(mesh, elemId);
    elementsByStorey[mesh.storeyIndex].push(elemId);
  }

  // Containment relations
  for (let i = 0; i < storeys.length; i++) {
    const elems = elementsByStorey[i];
    if (elems.length === 0) continue;
    lines.push(`${nextId()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',${ownerHistory},$,$,(${elems.join(',')}),${storeyEntities[i]});`);
  }

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
    if (meshes.length === 0) throw new Error('No meshes found in GLB file');

    for (const mesh of meshes) mesh.classification = classifyMeshFirstPass(mesh);

    // First detect preliminary storeys, then use them to decide whether a thin
    // element starts at floor level (door) or above it (window). Re-run storey
    // detection after refinement so reclassified opening panels do not pollute
    // the wall-base fallback.
    let storeys = detectStoreys(meshes);
    refineOpenings(meshes, storeys);
    storeys = detectStoreys(meshes);
    assignStoreys(meshes, storeys);

    const roofRefinement = refineRoofs(meshes, storeys);
    if (roofRefinement.promoted > 0) {
      storeys = detectStoreys(meshes);
      assignStoreys(meshes, storeys);
    }

    markExternalWalls(meshes, storeys);
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

    const { content, stats, storeyCount } = generateIFC(meshes, storeys, originalName);
    console.log(`  Classified: ${stats.wall} walls, ${stats.slab} slabs, ${stats.beam} beams, ${stats.column} columns, ${stats.stair} stairs, ${stats.roof} roofs, ${stats.door} doors, ${stats.window} windows, ${stats.proxy} proxies`);
    console.log(`  Pset_WallCommon IsExternal=true on ${stats.externalWall || 0} wall(s)`);
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

app.listen(PORT, () => {
  console.log(`\n  GLB → IFC converter`);
  console.log(`  ───────────────────`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
