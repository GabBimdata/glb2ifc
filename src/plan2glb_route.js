// src/plan2glb_route.js
//
// Route Express : POST /plan2glb
// - Lance automatiquement le service Python (plan_detector) au premier appel
// - Reçoit image + scale + height → appelle le Python → construit un GLB
// - v8 : les murs générés portent le même contrat runtime que les murs créés
//        dans le modeler : wallPath + openings[] + normals + extras mesh/node.
//
// Branchement dans server.js :
//   import planToGlb from './src/plan2glb_route.js';
//   app.use(planToGlb);

import { Router } from 'express';
import multer from 'multer';
import { Document, NodeIO } from '@gltf-transform/core';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const PY_PORT = parseInt(process.env.PLAN_DETECTOR_PORT || '8765', 10);
const PY_URL = process.env.PLAN_DETECTOR_URL || `http://127.0.0.1:${PY_PORT}`;
const PY_DIR = path.resolve(__dirname, '..', 'plan_detector');

// ---------- Auto-start Python ----------

let pyProcess = null;
let pyReady = false;
let pyStarting = false;
let pyError = null;

function findPython() {
  if (process.platform === 'win32') return ['python', 'python3'];
  return ['python3', 'python'];
}

function venvPython() {
  const isWin = process.platform === 'win32';
  const venvDir = path.join(PY_DIR, '.venv');
  return isWin
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

async function startPythonService() {
  if (pyProcess || pyStarting) return;
  pyStarting = true;
  pyError = null;

  const fs = await import('fs');
  const venvPy = venvPython();
  const hasVenv = fs.existsSync(venvPy);
  const pythonCandidates = hasVenv ? [venvPy] : findPython();
  let usedPython = null;

  for (const py of pythonCandidates) {
    try {
      const proc = spawn(py, [
        '-m', 'uvicorn', 'main:app',
        '--host', '127.0.0.1',
        '--port', String(PY_PORT),
      ], {
        cwd: PY_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });

      const earlyExit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        proc.on('error', () => { clearTimeout(timer); resolve(true); });
        proc.on('exit', (code) => {
          if (code !== null) { clearTimeout(timer); resolve(true); }
        });
      });

      if (earlyExit) continue;

      pyProcess = proc;
      usedPython = py;

      proc.stdout.on('data', (d) => {
        const s = d.toString();
        if (s.includes('Uvicorn running') || s.includes('Application startup complete')) pyReady = true;
      });
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        if (s.includes('Uvicorn running') || s.includes('Application startup complete')) pyReady = true;
        if (s.includes('ERROR') || s.includes('Traceback')) console.error('[plan_detector]', s.trim());
      });
      proc.on('exit', (code) => {
        console.log(`[plan_detector] exited (code ${code})`);
        pyProcess = null;
        pyReady = false;
      });

      break;
    } catch {
      continue;
    }
  }

  pyStarting = false;

  if (!pyProcess) {
    pyError = 'Cannot start plan_detector — Python not found or deps missing. '
            + 'Run: cd plan_detector && python -m venv .venv && '
            + (process.platform === 'win32' ? '.venv\\Scripts\\activate' : 'source .venv/bin/activate')
            + ' && pip install -r requirements.txt';
    console.warn('[plan2glb]', pyError);
    return;
  }

  console.log(`[plan_detector] starting with ${usedPython} on port ${PY_PORT}...`);

  const deadline = Date.now() + 15000;
  while (!pyReady && Date.now() < deadline) {
    try {
      const r = await fetch(`${PY_URL}/health`);
      if (r.ok) { pyReady = true; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (pyReady) console.log(`[plan_detector] ready on ${PY_URL}`);
  else {
    pyError = 'plan_detector started but did not become ready in 15s';
    console.warn('[plan2glb]', pyError);
  }
}

process.on('exit', () => { pyProcess?.kill(); });
process.on('SIGINT', () => { pyProcess?.kill(); process.exit(); });
process.on('SIGTERM', () => { pyProcess?.kill(); process.exit(); });

// ---------- Geometry helpers ----------

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function wallLength(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

function wallCenter(w) {
  return { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 };
}

function buildWallBox(x1, y1, x2, y2, thickness_m, height_m) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;

  const nx = (-dy / len) * (thickness_m / 2);
  const ny = (dx / len) * (thickness_m / 2);

  const b0 = [x1 + nx, y1 + ny, 0];
  const b1 = [x1 - nx, y1 - ny, 0];
  const b2 = [x2 - nx, y2 - ny, 0];
  const b3 = [x2 + nx, y2 + ny, 0];
  const t0 = [b0[0], b0[1], height_m];
  const t1 = [b1[0], b1[1], height_m];
  const t2 = [b2[0], b2[1], height_m];
  const t3 = [b3[0], b3[1], height_m];

  return {
    positions: new Float32Array([
      ...b0, ...b1, ...b2, ...b3,
      ...t0, ...t1, ...t2, ...t3,
    ]),
    indices: new Uint32Array([
      0,2,1, 0,3,2,
      4,5,6, 4,6,7,
      0,1,5, 0,5,4,
      1,2,6, 1,6,5,
      2,3,7, 2,7,6,
      3,0,4, 3,4,7,
    ]),
  };
}

function computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;

    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }

  return normals;
}

function makeWallExtras(wall, index, height_m) {
  const length = wallLength(wall);
  const center = wallCenter(wall);
  const id = `plan-wall-${index + 1}`;

  // Coordonnées 2D en repère plan, utiles pour debug et régénération.
  const baseline2d = {
    x1: wall.x1,
    y1: wall.y1,
    x2: wall.x2,
    y2: wall.y2,
  };

  // Coordonnées runtime du modeler / three.js : Y vertical, plan au sol XZ.
  // Le routeur convertit déjà la géométrie plan (x, y_plan, z_h) en
  // glTF (x, z_h, -y_plan), donc la ligne hôte doit utiliser z=-y_plan.
  const start = { x: wall.x1, y: 0, z: -wall.y1 };
  const end = { x: wall.x2, y: 0, z: -wall.y2 };
  const center3d = { x: center.x, y: height_m / 2, z: -center.y };
  const baseline3d = {
    x1: start.x, y1: start.y, z1: start.z,
    x2: end.x, y2: end.y, z2: end.z,
  };

  const wallPath = {
    start,
    end,
    prev: null,
    next: null,
    height: height_m,
    thickness: wall.thickness,
    alignment: 'center',
    kind: 'wall',
    baseElevation: 0,
    storeyId: 'storey-0',
    storeyName: 'Storey 0',
    openings: [],
  };

  const dimensions = {
    length,
    height: height_m,
    thickness: wall.thickness,
    alignment: 'center',
    kind: 'wall',
  };

  const authoring = {
    type: 'wall',
    kind: 'wall',
    elementType: 'wall',
    category: 'wall',
    isWall: true,
    isAuthoring: true,
    isAuthoringWall: true,
    openingHost: true,
    canHostOpenings: true,
    hostOpenings: true,
    wallHeight: height_m,
    height: height_m,
    wallThickness: wall.thickness,
    thickness: wall.thickness,
    wallLength: length,
    length,
    baseline: baseline3d,
    centerline: baseline3d,
    baseline2d,
    centerline2d: baseline2d,
    start,
    end,
    wallPath,
    dimensions,
  };

  // Beaucoup de clés sont volontairement redondantes. Le modeler a évolué par
  // itérations et certaines fonctions lisent des champs plats, d'autres un
  // objet authoring/wall. Ce bloc rend les murs détectés compatibles avec les
  // variantes actuelles sans casser l'export IFC.
  return {
    name: `Wall_${String(index + 1).padStart(3, '0')}`,
    smeltSource: 'plan_detector',
    smeltPlanDetectorVersion: 6,
    smeltDetectedFromPlan: true,
    smeltIfcType: 'IfcWall',
    ifcHint: 'IfcWall',
    smeltPredefinedType: '.STANDARD.',
    ifcType: 'IfcWall',
    IFCType: 'IfcWall',

    type: 'wall',
    kind: 'wall',
    category: 'wall',
    elementType: 'wall',
    modelerType: 'wall',
    modelerKind: 'wall',
    authoringType: 'wall',
    authoringKind: 'wall',
    authoringElementType: 'wall',
    smeltAuthoringType: 'wall',
    smeltObjectType: 'wall',
    smeltKind: 'wall',

    isWall: true,
    isAuthoring: true,
    authoringElement: true,
    isAuthoringElement: true,
    isAuthoringWall: true,
    authoringWall: true,
    smeltOpeningHost: true,
    openingHost: true,
    hostOpenings: true,
    canHostOpenings: true,

    wallId: id,
    storeyId: 'storey-0',
    storeyName: 'Storey 0',
    storeyElevation: 0,
    modelerId: index + 1,
    __modelerId: index + 1,
    wallType: 'wall',
    wallHeight: height_m,
    height: height_m,
    wallThickness: wall.thickness,
    thickness: wall.thickness,
    wallLength: length,
    length,
    dimensions,
    wallPath,
    wallCenter: center3d,
    center: center3d,
    baseline: baseline3d,
    centerline: baseline3d,
    wallLine: baseline3d,
    baseline2d,
    centerline2d: baseline2d,
    start,
    end,

    authoring,
    smeltAuthoring: authoring,
    wall: authoring,
  };
}

async function buildGlbFromWalls(walls_m, height_m, detection = null) {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('PlanScene');
  scene.setExtras({
    smeltSource: 'plan_detector',
    smeltPlanDetectorVersion: 6,
    wallCount: walls_m.length,
    imageSizePx: detection?.image_size_px || null,
    scaleMmPerPx: detection?.scale_mm_per_px || null,
  });

  const root = doc.createNode('Plan_Detected_Walls').setTranslation([0, 0, 0]);
  root.setExtras({
    smeltSource: 'plan_detector',
    smeltDetectedFromPlan: true,
    authoringType: 'group',
  });
  scene.addChild(root);

  const wallMaterial = doc.createMaterial('Detected wall')
    .setBaseColorFactor([0.68, 0.68, 0.64, 1])
    .setRoughnessFactor(0.86)
    .setMetallicFactor(0.0);

  walls_m.forEach((w, i) => {
    const box = buildWallBox(w.x1, w.y1, w.x2, w.y2, w.thickness, height_m);
    if (!box) return;

    // Z-up plan → Y-up glTF: (x, y_plan, z_h) → (x, z_h, -y_plan)
    const pos = new Float32Array(box.positions.length);
    for (let k = 0; k < box.positions.length; k += 3) {
      pos[k]     = box.positions[k];
      pos[k + 1] = box.positions[k + 2];
      pos[k + 2] = -box.positions[k + 1];
    }

    const normals = computeVertexNormals(pos, box.indices);
    const pAcc = doc.createAccessor(`Wall_${String(i + 1).padStart(3, '0')}_POSITION`).setType('VEC3').setArray(pos);
    const nAcc = doc.createAccessor(`Wall_${String(i + 1).padStart(3, '0')}_NORMAL`).setType('VEC3').setArray(normals);
    const iAcc = doc.createAccessor(`Wall_${String(i + 1).padStart(3, '0')}_INDEX`).setType('SCALAR').setArray(box.indices);
    const prim = doc.createPrimitive().setAttribute('POSITION', pAcc).setAttribute('NORMAL', nAcc).setIndices(iAcc).setMaterial(wallMaterial);
    const meshName = `Wall_${String(i + 1).padStart(3, '0')}`;
    const extras = makeWallExtras(w, i, height_m);
    const mesh = doc.createMesh(meshName).addPrimitive(prim).setExtras(extras);
    const node = doc.createNode(meshName).setMesh(mesh).setExtras(extras);
    root.addChild(node);
  });

  const io = new NodeIO();
  return io.writeBinary(doc);
}

function parseDetectorParams(body = {}) {
  return {
    minWallLengthMm: finiteNumber(body.min_wall_length_mm, 400),
    minWallThicknessMm: finiteNumber(body.min_wall_thickness_mm, 80),
    maxWallThicknessMm: finiteNumber(body.max_wall_thickness_mm, 900),
  };
}

function appendDetectorFormFields(fd, params) {
  fd.append('min_wall_length_mm', String(params.minWallLengthMm));
  fd.append('min_wall_thickness_mm', String(params.minWallThicknessMm));
  fd.append('max_wall_thickness_mm', String(params.maxWallThicknessMm));
}

async function callDetector(req, scale_mm_per_px) {
  const detectorParams = parseDetectorParams(req.body);
  const fd = new FormData();
  fd.append('image',
    new Blob([req.file.buffer], { type: req.file.mimetype }),
    req.file.originalname || 'plan.png'
  );
  fd.append('scale_mm_per_px', String(scale_mm_per_px));
  appendDetectorFormFields(fd, detectorParams);

  const pyResp = await fetch(`${PY_URL}/detect`, { method: 'POST', body: fd });
  if (!pyResp.ok) {
    const txt = await pyResp.text();
    const error = new Error('detector failed');
    error.status = 502;
    error.detail = txt;
    throw error;
  }

  return pyResp.json();
}

// ---------- Routes ----------

router.get('/api/plan-detector-status', (req, res) => {
  res.json({
    running: !!pyProcess,
    ready: pyReady,
    error: pyError,
    url: PY_URL,
  });
});

// Détection JSON pratique pour debug UI.
router.post('/api/plan-detect', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'missing image' });
    const scale_mm_per_px = parseFloat(req.body.scale_mm_per_px);
    if (!Number.isFinite(scale_mm_per_px) || scale_mm_per_px <= 0) {
      return res.status(400).json({ error: 'invalid scale_mm_per_px' });
    }

    if (!pyProcess && !pyStarting) await startPythonService();
    if (!pyReady) {
      return res.status(503).json({
        error: 'Plan detector not ready',
        detail: pyError || 'Service starting, try again in a few seconds',
      });
    }

    const detection = await callDetector(req, scale_mm_per_px);
    res.json(detection);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, detail: err.detail });
    console.error('[plan-detect] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Conversion principale : retourne directement un .glb téléchargeable.
router.post('/plan2glb', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'missing image' });

    const scale_mm_per_px = parseFloat(req.body.scale_mm_per_px);
    const wall_height_m = parseFloat(req.body.wall_height_m || '2.5');
    if (!Number.isFinite(scale_mm_per_px) || scale_mm_per_px <= 0) {
      return res.status(400).json({ error: 'invalid scale_mm_per_px' });
    }
    if (!Number.isFinite(wall_height_m) || wall_height_m <= 0) {
      return res.status(400).json({ error: 'invalid wall_height_m' });
    }

    if (!pyProcess && !pyStarting) await startPythonService();
    if (!pyReady) {
      return res.status(503).json({
        error: 'Plan detector not ready',
        detail: pyError || 'Service starting, try again in a few seconds',
      });
    }

    const detection = await callDetector(req, scale_mm_per_px);

    // mm → m. Les cloisons très fines sont gardées éditables ; clamp mini à 5 cm.
    const walls_m = (detection.walls || []).map((w) => ({
      x1: w.x1_mm / 1000,
      y1: w.y1_mm / 1000,
      x2: w.x2_mm / 1000,
      y2: w.y2_mm / 1000,
      thickness: Math.max(0.05, w.thickness_mm / 1000),
    })).filter((w) => wallLength(w) > 0.05);

    if (walls_m.length === 0) {
      return res.status(422).json({ error: 'no walls detected', detection });
    }

    const glb = await buildGlbFromWalls(walls_m, wall_height_m, detection);
    const filename = String(req.body.filename || 'plan_detected_walls.glb')
      .replace(/[^A-Za-z0-9_.-]+/g, '_')
      .replace(/_+$/, '') || 'plan_detected_walls.glb';

    res.set({
      'Content-Type': 'model/gltf-binary',
      'Content-Disposition': `attachment; filename="${filename.endsWith('.glb') ? filename : `${filename}.glb`}"`,
      'X-Wall-Count': String(walls_m.length),
      'X-Smelt-Plan-Detector': 'v6',
    });
    res.send(Buffer.from(glb));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, detail: err.detail });
    console.error('[plan2glb] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

export default router;
