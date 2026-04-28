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

const STOREY_LEVEL_TOLERANCE = 0.35;
const MIN_STOREY_HEIGHT = 1.8;

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


function looksLikeBeam(mesh) {
  const s = bboxStats(mesh);
  const f = triangleFaceAnalysis(mesh);

  if (hasDoorHint(mesh) || hasWindowHint(mesh) || hasRoofHint(mesh)) return false;

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

  if (looksLikeBeam(mesh)) {
    return 'beam';
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
      continue;
    }
  }

  // Promote remaining wall_candidates after openings have had a chance to move.
  for (const m of meshes) {
    if (m.classification === 'wall_candidate') m.classification = 'wall';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storey detection
// ─────────────────────────────────────────────────────────────────────────────

function detectStoreys(meshes) {
  const slabs = meshes.filter(m => m.classification === 'slab');
  const likelyFloorSlabs = slabs.filter(m => {
    const s = bboxStats(m);
    return s.areaXZ >= 2.0 || hasSlabHint(m);
  });

  // Prefer slab top elevations when available: that is usually the floor level
  // where walls/doors start. Small slabs are ignored first to avoid tables,
  // shelves, etc. creating fake storeys.
  const slabSources = (likelyFloorSlabs.length > 0 ? likelyFloorSlabs : slabs).map(slab => ({
    y: bboxStats(slab).maxY,
    weight: hasSlabHint(slab) ? 4 : 3
  }));

  // Fallback / reinforcement: cluster bases of tall vertical elements. This
  // recovers storeys for wall-only models and stabilises noisy slab exports.
  const wallBaseSources = meshes
    .filter(m => m.classification === 'wall_candidate' || m.classification === 'wall')
    .filter(m => bboxStats(m).sizeY >= 1.4)
    .map(wall => ({ y: bboxStats(wall).minY, weight: hasWallHint(wall) ? 2 : 1 }));

  const sources = slabSources.length > 0 ? [...slabSources, ...wallBaseSources] : wallBaseSources;

  if (sources.length === 0) {
    return [{ elevation: 0, name: 'Storey 0' }];
  }

  const rawLevels = clusterLevels(sources).map(cluster => weightedAverage(cluster));
  const levels = dedupeStoreyLevels(rawLevels);

  return (levels.length > 0 ? levels : [0]).map((elevation, idx) => ({
    elevation,
    name: `Storey ${idx}`
  }));
}

function assignStoreys(meshes, storeys) {
  for (const mesh of meshes) {
    const s = bboxStats(mesh);

    // Use the base for vertical elements. Using the centre is a common source of
    // mistakes: a 3m ground-floor wall can have its centre above the next slab.
    const verticalElement = ['wall', 'door', 'window'].includes(mesh.classification);
    const referenceY = verticalElement ? s.minY + 0.05 : s.centerY;
    mesh.storeyIndex = storeys.indexOf(floorForY(referenceY, storeys));
    if (mesh.storeyIndex < 0) mesh.storeyIndex = 0;
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

    if (mesh.classification === 'door' || mesh.classification === 'window' || mesh.classification === 'wall' || mesh.classification === 'beam') {
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

  // Build elements grouped by storey
  const elementsByStorey = Array.from({ length: storeys.length }, () => []);
  const stats = { wall: 0, slab: 0, beam: 0, roof: 0, door: 0, window: 0, proxy: 0, externalWall: 0 };

  const nameCounters = { wall: 0, slab: 0, beam: 0, roof: 0, door: 0, window: 0, proxy: 0 };
  const nameLabels = {
    wall: 'Wall',
    slab: 'Slab',
    beam: 'Beam',
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
      } else if (mesh.classification === 'roof') {
        addRoofCommonPset(elemId, mesh);
      }
    }

    elementsByStorey[mesh.storeyIndex].push(elemId);
  }

  // Containment relations
  for (let i = 0; i < storeys.length; i++) {
    const elems = elementsByStorey[i];
    if (elems.length === 0) continue;
    lines.push(`${nextId()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',${ownerHistory},$,$,(${elems.join(',')}),${storeyEntities[i]});`);
  }

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

    const externalWalls = meshes.filter(m => m.classification === 'wall' && m.isExternal).length;
    console.log(`  Detected ${externalWalls} external wall(s)`);

    const { content, stats, storeyCount } = generateIFC(meshes, storeys, originalName);
    console.log(`  Classified: ${stats.wall} walls, ${stats.slab} slabs, ${stats.beam} beams, ${stats.roof} roofs, ${stats.door} doors, ${stats.window} windows, ${stats.proxy} proxies`);
    console.log(`  Pset_WallCommon IsExternal=true on ${stats.externalWall || 0} wall(s)`);

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
