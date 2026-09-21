// Smelt Studio — calage automatique d'un plan d'étage.
// Idée : les murs extérieurs se superposent d'un étage à l'autre. On cherche donc la position
// (et le quart de tour) du nouveau plan qui fait tomber ses traits épais sur les murs connus.
//
// Méthode : on rastérise les murs de référence et le plan sur une même grille métrique,
// puis on maximise la corrélation normalisée entre les deux masques (recherche grossière,
// puis affinée autour du meilleur résultat).
import * as G from './geometry.js';
import { WALL_TYPES } from './catalog.js';
import { planImageToWorld, rotatePlan } from './model.js';

// Murs servant de référence : extérieurs d'abord (ils se superposent entre étages)
export function referenceWalls(level) {
  const polys = G.computeWallPolygons(level);
  const all = level.walls.filter((w) => polys.get(w.id));
  const ext = all.filter((w) => WALL_TYPES[w.type]?.category === 'exterior');
  const chosen = ext.length >= 3 ? ext : all;
  return chosen.map((w) => polys.get(w.id));
}

function bboxOf(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const q of p) {
    x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
  }
  return { x0, y0, x1, y1 };
}

// Masque de référence : murs remplis sur la grille
function rasterReference(polys, grid, dilateCells = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = grid.nx; canvas.height = grid.ny;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  for (const poly of polys) {
    ctx.beginPath();
    poly.forEach((p, i) => {
      const x = (p[0] - grid.x0) / grid.cell, y = (p[1] - grid.y0) / grid.cell;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    if (dilateCells > 0) {
      // murs épaissis pour la passe grossière : le pic de corrélation s'élargit
      // et ne peut plus tomber entre deux pas de recherche
      ctx.lineWidth = dilateCells * 2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }
  const data = ctx.getImageData(0, 0, grid.nx, grid.ny).data;
  const cells = [];
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
    if (data[(j * grid.nx + i) * 4 + 3] > 100) cells.push(i, j);
  }
  return cells;
}

// Masque du plan : un pixel de grille est « mur » s'il est majoritairement sombre.
// Le moyennage de la mise à l'échelle efface les traits fins (cotes, textes, hachures).
function rasterPlan(img, plan, grid, margin) {
  const nx = grid.nx + 2 * margin, ny = grid.ny + 2 * margin;
  const canvas = document.createElement('canvas');
  canvas.width = nx; canvas.height = ny;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, nx, ny);
  const r = ((plan.rotation || 0) * Math.PI) / 180;
  const k = plan.scale / grid.cell;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(
    Math.cos(r) * k, Math.sin(r) * k, -Math.sin(r) * k, Math.cos(r) * k,
    (plan.x - grid.x0) / grid.cell + margin, (plan.y - grid.y0) / grid.cell + margin,
  );
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, nx, ny).data;
  const mask = new Uint8Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    mask[i] = lum < 110 ? 1 : 0;
  }
  // image intégrale pour la densité locale de sombre
  const integral = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j < ny; j++) {
    let row = 0;
    for (let i = 0; i < nx; i++) {
      row += mask[j * nx + i];
      integral[(j + 1) * (nx + 1) + (i + 1)] = integral[j * (nx + 1) + (i + 1)] + row;
    }
  }
  return { mask, nx, ny, integral };
}

// Corrélation normalisée entre la référence (cellules actives) et le plan décalé de (dx, dy)
function scoreAt(refCells, grid, planMask, margin, dx, dy) {
  const { mask, nx, ny, integral } = planMask;
  let hits = 0;
  for (let c = 0; c < refCells.length; c += 2) {
    const i = refCells[c] + margin - dx, j = refCells[c + 1] + margin - dy;
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    hits += mask[j * nx + i];
  }
  const n = grid.nx * grid.ny;
  const i0 = margin - dx, j0 = margin - dy;
  if (i0 < 0 || j0 < 0 || i0 + grid.nx > nx || j0 + grid.ny > ny) return -1;
  const W = nx + 1;
  const dark = integral[(j0 + grid.ny) * W + (i0 + grid.nx)] - integral[j0 * W + (i0 + grid.nx)]
    - integral[(j0 + grid.ny) * W + i0] + integral[j0 * W + i0];
  const muR = refCells.length / 2 / n, muI = dark / n;
  const sR = Math.sqrt(muR * (1 - muR)), sI = Math.sqrt(muI * (1 - muI));
  if (sR < 1e-9 || sI < 1e-9) return -1;
  return (hits / n - muR * muI) / (sR * sI);
}

function search(refCells, grid, planMask, margin, range, step, center = [0, 0]) {
  let best = { score: -Infinity, dx: 0, dy: 0 };
  for (let dy = center[1] - range; dy <= center[1] + range; dy += step) {
    for (let dx = center[0] - range; dx <= center[0] + range; dx += step) {
      const s = scoreAt(refCells, grid, planMask, margin, dx, dy);
      if (s > best.score) best = { score: s, dx, dy };
    }
  }
  return best;
}

/**
 * Cherche la meilleure superposition du plan sur les murs de référence.
 * Ne modifie rien : renvoie la transformation proposée et un indice de confiance (0–1).
 */
export function autoAlignPlan(plan, img, refPolys, { rotations = [0, 90, 180, 270], searchMeters = 30, preferRotation = null } = {}) {
  if (!refPolys.length || !img?.naturalWidth) return null;
  const box = bboxOf(refPolys);
  const pad = 1;
  const pivot = planImageToWorld(plan, [img.naturalWidth / 2, img.naturalHeight / 2]);

  const results = [];
  for (const rot of rotations) {
    const candidate = { ...plan };
    if (rot) rotatePlan(candidate, rot, pivot);

    // 1. recherche grossière (cellules de 25 cm) sur une large zone
    const coarse = { cell: 0.25, x0: box.x0 - pad, y0: box.y0 - pad };
    coarse.nx = Math.ceil((box.x1 - box.x0 + 2 * pad) / coarse.cell);
    coarse.ny = Math.ceil((box.y1 - box.y0 + 2 * pad) / coarse.cell);
    const marginC = Math.ceil(searchMeters / coarse.cell);
    const refC = rasterReference(refPolys, coarse, 1.5);
    const maskC = rasterPlan(img, candidate, coarse, marginC);
    const b1 = search(refC, coarse, maskC, marginC, marginC, 2);
    const refC0 = rasterReference(refPolys, coarse);
    const b1r = search(refC0, coarse, maskC, marginC, 3, 1, [b1.dx, b1.dy]);

    // 2. affinage (cellules de 5 cm) autour du meilleur résultat
    const fine = { cell: 0.05, x0: box.x0 - pad, y0: box.y0 - pad };
    fine.nx = Math.ceil((box.x1 - box.x0 + 2 * pad) / fine.cell);
    fine.ny = Math.ceil((box.y1 - box.y0 + 2 * pad) / fine.cell);
    const shift = [Math.round((b1r.dx * coarse.cell) / fine.cell), Math.round((b1r.dy * coarse.cell) / fine.cell)];
    const marginF = Math.abs(shift[0]) + Math.abs(shift[1]) + 12;
    const refF = rasterReference(refPolys, fine);
    const maskF = rasterPlan(img, candidate, fine, marginF);
    const b2 = search(refF, fine, maskF, marginF, 10, 1, shift);

    results.push({ score: b2.score, rotation: rot, dx: b2.dx * fine.cell, dy: b2.dy * fine.cell, pivot });
  }
  if (!results.length) return null;
  // Un contour symétrique (maison rectangulaire) donne le même score à 0° et 180° :
  // à score quasi égal, on garde l'orientation du plan de référence (même dossier, même sens).
  const top = Math.max(...results.map((r) => r.score));
  const target = preferRotation ?? (plan.rotation || 0);
  const angleGap = (r) => {
    const final = (((plan.rotation || 0) + r.rotation) % 360 + 360) % 360;
    const d = Math.abs(final - (((target % 360) + 360) % 360));
    return Math.min(d, 360 - d);
  };
  const best = results
    .filter((r) => r.score >= top - 0.03)
    .sort((a, b) => angleGap(a) - angleGap(b) || b.score - a.score)[0];
  return {
    rotation: best.rotation,
    dx: best.dx,
    dy: best.dy,
    pivot: best.pivot,
    confidence: Math.max(0, Math.min(1, best.score)),
  };
}

// Applique le résultat d'autoAlignPlan à un plan (mutation)
export function applyAlignment(plan, result) {
  if (result.rotation) rotatePlan(plan, result.rotation, result.pivot);
  plan.x += result.dx;
  plan.y += result.dy;
}
