// Smelt Studio — menuiseries : fenêtres à vantaux, portes, volets battants.
// Module pur, partagé par les fenêtres de façade, les portes et les baies de lucarne.
//
// Repère local : x le long de la largeur (centré), y dans l'épaisseur du mur
// (0 = plan médian du dormant, y > 0 vers l'extérieur), z depuis le bas de la baie.

export const SHUTTER_MODES = { none: 'Aucun', open: 'Ouverts', closed: 'Fermés' };

const F = 0.06;   // largeur du dormant
const FD = 0.07;  // profondeur du dormant
const S = 0.055;  // largeur des montants et traverses d'ouvrant

function box(x0, x1, y0, y1, z0, z1) {
  const positions = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const triangles = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return { positions, triangles };
}

// Nombre de vantaux par défaut : réglable par ouverture
export function defaultLeaves(op, catalog = {}) {
  if (Number.isFinite(op.leaves) && op.leaves >= 1) return Math.min(4, Math.round(op.leaves));
  if (Number.isFinite(catalog.leaves)) return catalog.leaves;
  if (op.kind === 'door') return op.width >= 1.2 ? 2 : 1;
  return op.width >= 0.8 ? 2 : 1;
}

// Un volet battant : lames verticales et trois barres, battant vers la gauche ou la droite
function shutterLeaf(x0, x1, h, yBoards, yBars) {
  const out = [];
  const w = x1 - x0;
  const n = Math.max(2, Math.round(w / 0.12));
  const gap = 0.006;
  const bw = (w - (n - 1) * gap) / n;
  for (let i = 0; i < n; i++) {
    const a = x0 + i * (bw + gap);
    out.push(box(a, a + bw, yBoards[0], yBoards[1], 0.02, h - 0.02));
  }
  for (const zc of [0.14, h / 2, h - 0.14]) {
    out.push(box(x0 + 0.03, x1 - 0.03, yBars[0], yBars[1], zc - 0.05, zc + 0.05));
  }
  return out;
}

/**
 * Pièces d'une menuiserie.
 * op : { kind: 'window' | 'door', type, width, height, leaves?, bars?, shutters? }
 * opts : { sliding, frenchWindow, exterior: distance du plan médian au nu extérieur (ou null),
 *          sill: dessiner l'appui extérieur, shutters: autoriser les volets }
 * Retour : { frame: [...], glass: [...], door: [...], sill: [...], handle: [...], shutter: [...], leaves }
 */
export function joineryParts(op, opts = {}) {
  const w = op.width, h = op.height;
  const parts = { frame: [], glass: [], door: [], sill: [], handle: [], shutter: [] };
  const leaves = opts.leaves ?? defaultLeaves(op);
  const door = op.kind === 'door';
  const low = opts.frenchWindow || door; // pas de traverse basse de dormant

  // — dormant —
  parts.frame.push(box(-w / 2, -w / 2 + F, -FD / 2, FD / 2, 0, h));
  parts.frame.push(box(w / 2 - F, w / 2, -FD / 2, FD / 2, 0, h));
  parts.frame.push(box(-w / 2 + F, w / 2 - F, -FD / 2, FD / 2, h - F, h));
  if (low) parts.frame.push(box(-w / 2 + F, w / 2 - F, -FD / 2, FD / 2, 0, 0.02)); // seuil
  else parts.frame.push(box(-w / 2 + F, w / 2 - F, -FD / 2, FD / 2, 0, F));

  const X0 = -w / 2 + F, X1 = w / 2 - F;
  const Z0 = low ? 0.02 : F, Z1 = h - F;

  if (door) {
    // — vantaux de porte : panneau plein, deux moulures côté extérieur, poignées —
    const lw = (X1 - X0) / leaves;
    for (let i = 0; i < leaves; i++) {
      const a = X0 + i * lw + 0.003, b = a + lw - 0.006;
      parts.door.push(box(a, b, -0.022, 0.022, Z0 + 0.005, Z1 - 0.003));
      const inset = Math.min(0.12, lw * 0.18);
      const zMid = (Z1 - Z0) * 0.48 + Z0;
      parts.door.push(box(a + inset, b - inset, 0.022, 0.032, Z0 + 0.15, zMid - 0.06));
      parts.door.push(box(a + inset, b - inset, 0.022, 0.032, zMid + 0.06, Z1 - 0.15));
      // poignée du côté de la rencontre (ou côté opposé aux paumelles pour un seul vantail)
      const hx = leaves === 1 ? b - 0.07 : (i === 0 ? b - 0.07 : a + 0.07);
      for (const [y0, y1] of [[-0.075, -0.022], [0.032, 0.085]]) {
        parts.handle.push(box(hx - 0.012, hx + 0.012, y0, y1, 1.02, 1.05));
        parts.handle.push(box(hx - 0.02, hx + 0.02, y0 < 0 ? y1 - 0.012 : y0, y0 < 0 ? y1 : y0 + 0.012, 0.98, 1.12));
      }
    }
    return { ...parts, leaves };
  }

  // — vantaux vitrés —
  const sliding = !!opts.sliding;
  const lw = (X1 - X0) / leaves;
  const bottomRail = opts.frenchWindow ? 0.13 : S;
  for (let i = 0; i < leaves; i++) {
    // coulissant : vantaux élargis qui se recouvrent, sur deux rails décalés
    const a = sliding ? X0 + i * lw - (i ? 0.04 : 0) : X0 + i * lw;
    const b = sliding ? a + lw + 0.04 : a + lw;
    const dy = sliding ? (i % 2 ? 0.018 : -0.018) : -0.012;
    const y0 = dy - 0.027, y1 = dy + 0.027;
    parts.frame.push(box(a, a + S, y0, y1, Z0, Z1));
    parts.frame.push(box(b - S, b, y0, y1, Z0, Z1));
    parts.frame.push(box(a + S, b - S, y0, y1, Z1 - S, Z1));
    parts.frame.push(box(a + S, b - S, y0, y1, Z0, Z0 + bottomRail));
    parts.glass.push(box(a + S, b - S, dy - 0.006, dy + 0.006, Z0 + bottomRail, Z1 - S));
    // petits bois : traverses horizontales, et un meneau si le vantail est large
    if (op.bars) {
      const gh = (Z1 - S) - (Z0 + bottomRail);
      const rows = Math.max(2, Math.round(gh / 0.42));
      for (let r = 1; r < rows; r++) {
        const zc = Z0 + bottomRail + (gh * r) / rows;
        parts.frame.push(box(a + S, b - S, dy - 0.012, dy + 0.012, zc - 0.013, zc + 0.013));
      }
      if (b - a > 0.62) {
        const xc = (a + b) / 2;
        parts.frame.push(box(xc - 0.013, xc + 0.013, dy - 0.012, dy + 0.012, Z0 + bottomRail, Z1 - S));
      }
    }
    // poignée côté intérieur, sur le montant de rencontre (ou du côté libre)
    const hx = leaves === 1 ? b - S / 2 : (i === leaves - 1 ? a + S / 2 : null);
    if (hx !== null && !sliding) {
      const hz = Math.min(1.1, Z0 + (Z1 - Z0) / 2);
      parts.handle.push(box(hx - 0.012, hx + 0.012, y0 - 0.03, y0, hz - 0.08, hz + 0.02));
    }
  }

  // — appui extérieur (fenêtre posée sur allège) —
  if (opts.sill && opts.exterior != null && !opts.frenchWindow) {
    parts.sill.push(box(-w / 2 - 0.04, w / 2 + 0.04, FD / 2 - 0.02, opts.exterior + 0.05, -0.05, 0.0));
  }

  // — volets battants, ouverts contre la façade ou fermés dans le tableau —
  const mode = op.shutters || 'none';
  if (opts.shutters && opts.exterior != null && mode !== 'none' && !sliding) {
    const e = opts.exterior;
    const count = w >= 0.8 ? 2 : 1;
    const sw = w / count;
    if (mode === 'open') {
      // rabattus à plat contre le mur, de part et d'autre : les barres se voient de dehors
      const boards = [e + 0.004, e + 0.032], bars = [e + 0.032, e + 0.054];
      parts.shutter.push(...shutterLeaf(-w / 2 - sw, -w / 2, h, boards, bars));
      if (count === 2) parts.shutter.push(...shutterLeaf(w / 2, w / 2 + sw, h, boards, bars));
    } else {
      // fermés dans le tableau, au nu extérieur : les barres regardent la fenêtre
      const boards = [e - 0.034, e - 0.006], bars = [e - 0.056, e - 0.034];
      if (count === 2) {
        parts.shutter.push(...shutterLeaf(-w / 2 + 0.005, -0.002, h, boards, bars));
        parts.shutter.push(...shutterLeaf(0.002, w / 2 - 0.005, h, boards, bars));
      } else {
        parts.shutter.push(...shutterLeaf(-w / 2 + 0.005, w / 2 - 0.005, h, boards, bars));
      }
    }
  }
  return { ...parts, leaves };
}

/**
 * Place des pièces locales dans le monde. toWorld(x, y) → [X, Y] (plan) ; z ajouté à zBase.
 * mirrored : le repère (x, y) → monde est indirect, il faut inverser l'ordre des sommets.
 */
export function placeJoinery(meshes, toWorld, zBase, mirrored) {
  return meshes.map((m) => ({
    positions: m.positions.map(([x, y, z]) => { const p = toWorld(x, y); return [p[0], p[1], zBase + z]; }),
    triangles: mirrored ? m.triangles.map(([a, b, c]) => [a, c, b]) : m.triangles,
  }));
}
