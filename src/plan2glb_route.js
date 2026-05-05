// src/plan2glb_route.js
//
// Route Express : POST /plan2glb
// - Lance automatiquement le service Python (plan_detector) au premier appel
// - Reçoit image + scale + height → appelle le Python → construit un GLB
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
  // Windows: try 'python' first (usually py3), then 'python3'
  // Linux/Mac: try 'python3' first, then 'python'
  if (process.platform === 'win32') {
    return ['python', 'python3'];
  }
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

  // Try venv python first, then system python
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

      // Wait a bit to see if it crashes immediately
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
        if (s.includes('Uvicorn running') || s.includes('Application startup complete')) {
          pyReady = true;
        }
      });
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        if (s.includes('Uvicorn running') || s.includes('Application startup complete')) {
          pyReady = true;
        }
        // Only log real errors, not the startup noise
        if (s.includes('ERROR') || s.includes('Traceback')) {
          console.error('[plan_detector]', s.trim());
        }
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

  // Wait for ready (max 15s)
  const deadline = Date.now() + 15000;
  while (!pyReady && Date.now() < deadline) {
    // Also try a health check
    try {
      const r = await fetch(`${PY_URL}/health`);
      if (r.ok) { pyReady = true; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (pyReady) {
    console.log(`[plan_detector] ready on ${PY_URL}`);
  } else {
    pyError = 'plan_detector started but did not become ready in 15s';
    console.warn('[plan2glb]', pyError);
  }
}

// Cleanup on process exit
process.on('exit', () => { pyProcess?.kill(); });
process.on('SIGINT', () => { pyProcess?.kill(); process.exit(); });
process.on('SIGTERM', () => { pyProcess?.kill(); process.exit(); });

// ---------- Geometry helpers ----------

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
      0,2,1, 0,3,2,   // bottom
      4,5,6, 4,6,7,   // top
      0,1,5, 0,5,4,   // sides
      1,2,6, 1,6,5,
      2,3,7, 2,7,6,
      3,0,4, 3,4,7,
    ]),
  };
}

async function buildGlbFromWalls(walls_m, height_m) {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('PlanScene');
  const root = doc.createNode('Plan').setTranslation([0, 0, 0]);
  scene.addChild(root);

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

    const pAcc = doc.createAccessor().setType('VEC3').setArray(pos);
    const iAcc = doc.createAccessor().setType('SCALAR').setArray(box.indices);
    const prim = doc.createPrimitive().setAttribute('POSITION', pAcc).setIndices(iAcc);
    const mesh = doc.createMesh(`wall_${i}`).addPrimitive(prim);
    const node = doc.createNode(`wall_${i}`).setMesh(mesh);
    root.addChild(node);
  });

  const io = new NodeIO();
  return io.writeBinary(doc);
}

// ---------- Routes ----------

// Health / status endpoint
router.get('/api/plan-detector-status', (req, res) => {
  res.json({
    running: !!pyProcess,
    ready: pyReady,
    error: pyError,
    url: PY_URL,
  });
});

// Main conversion
router.post('/plan2glb', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'missing image' });

    const scale_mm_per_px = parseFloat(req.body.scale_mm_per_px);
    const wall_height_m = parseFloat(req.body.wall_height_m || '2.5');
    if (!Number.isFinite(scale_mm_per_px) || scale_mm_per_px <= 0) {
      return res.status(400).json({ error: 'invalid scale_mm_per_px' });
    }

    // Auto-start Python if not running
    if (!pyProcess && !pyStarting) await startPythonService();
    if (!pyReady) {
      return res.status(503).json({
        error: 'Plan detector not ready',
        detail: pyError || 'Service starting, try again in a few seconds',
      });
    }

    // Call Python detector
    const fd = new FormData();
    fd.append('image',
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      req.file.originalname || 'plan.png'
    );
    fd.append('scale_mm_per_px', String(scale_mm_per_px));

    const pyResp = await fetch(`${PY_URL}/detect`, { method: 'POST', body: fd });
    if (!pyResp.ok) {
      const txt = await pyResp.text();
      return res.status(502).json({ error: 'detector failed', detail: txt });
    }
    const detection = await pyResp.json();

    // mm → m
    const walls_m = (detection.walls || []).map((w) => ({
      x1: w.x1_mm / 1000,
      y1: w.y1_mm / 1000,
      x2: w.x2_mm / 1000,
      y2: w.y2_mm / 1000,
      thickness: Math.max(0.05, w.thickness_mm / 1000),
    }));

    if (walls_m.length === 0) {
      return res.status(422).json({ error: 'no walls detected', detection });
    }

    // Build GLB
    const glb = await buildGlbFromWalls(walls_m, wall_height_m);

    res.set({
      'Content-Type': 'model/gltf-binary',
      'Content-Disposition': 'attachment; filename="plan.glb"',
      'X-Wall-Count': String(walls_m.length),
    });
    res.send(Buffer.from(glb));
  } catch (err) {
    console.error('[plan2glb] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

export default router;
