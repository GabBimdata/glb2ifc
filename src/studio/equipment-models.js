// Smelt Studio — équipements paramétriques.
// Chaque équipement est reconstruit à partir de ses dimensions, sans déformation :
// un plan de travail garde son épaisseur, un robinet reste un robinet.
// Module pur (aucune dépendance) : partagé par la vue 3D, l'export GLB et l'export IFC.
//
// Repère local, en mètres : x = largeur (centrée), y = profondeur (y < 0 contre le mur,
// y > 0 côté utilisateur), z = hauteur depuis le sol.

export const EQUIPMENT_MATERIALS = {
  ceramic: { color: '#f3f2ee', roughness: 0.35 },
  cabinet: { color: '#d9d2c5', roughness: 0.7 },
  worktop: { color: '#7d7468', roughness: 0.55 },
  metal: { color: '#aab2b6', roughness: 0.3, metalness: 0.7 },
  dark: { color: '#2d3236', roughness: 0.4 },
  glass: { color: '#cfe4ec', roughness: 0.05, opacity: 0.35 },
  appliance: { color: '#eef0f0', roughness: 0.4 },
  wood: { color: '#b08a62', roughness: 0.65 },
  fabric: { color: '#8a97a3', roughness: 0.9 },
  linen: { color: '#f1ede6', roughness: 0.9 },
};

// ─── Primitives ───────────────────────────────────────────────────────────────

function box(x0, x1, y0, y1, z0, z1) {
  const positions = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const triangles = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return { positions, triangles };
}

// Cylindre (ou ellipse) vertical
function cylZ(cx, cy, rx, ry, z0, z1, seg = 24) {
  const positions = [];
  const triangles = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    positions.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a), z0]);
  }
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    positions.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a), z1]);
  }
  const b = positions.length;
  positions.push([cx, cy, z0], [cx, cy, z1]);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    triangles.push([b, j, i], [b + 1, seg + i, seg + j], [i, j, seg + j], [i, seg + j, seg + i]);
  }
  return { positions, triangles };
}

// Cylindre couché, axe selon y (hublot, poignée…)
function cylY(cx, cz, r, y0, y1, seg = 24) {
  const m = cylZ(0, 0, r, r, y0, y1, seg);
  // Swapping y/z is a reflection, so triangle winding must also be reversed.
  return { positions: m.positions.map(([x, y, z]) => [cx + x, z, cz + y]), triangles: m.triangles.map(([a, b, c]) => [a, c, b]) };
}

// Cylindre couché, axe selon x (barre de serviette, pied de lit…)
function cylX(cy, cz, r, x0, x1, seg = 16) {
  const m = cylZ(0, 0, r, r, x0, x1, seg);
  return { positions: m.positions.map(([x, y, z]) => [z, cy + x, cz + y]), triangles: m.triangles };
}

function part(mat, mesh) { return { mat, mesh }; }

// ─── Éléments récurrents ──────────────────────────────────────────────────────

// Caisson de cuisine : socle en retrait, caisson, rainure de porte, poignée
function kitchenBase(w, d, h, { top = true, doors = 1 } = {}) {
  const parts = [];
  const plinth = 0.1, top_t = 0.03;
  const y0 = -d / 2, y1 = d / 2;
  const bodyTop = top ? h - top_t : h;
  parts.push(part('dark', box(-w / 2 + 0.01, w / 2 - 0.01, y0, y1 - 0.06, 0, plinth)));
  parts.push(part('cabinet', box(-w / 2, w / 2, y0, y1 - 0.02, plinth, bodyTop)));
  const leaf = w / doors;
  for (let i = 1; i < doors; i++) {
    const x = -w / 2 + leaf * i;
    parts.push(part('dark', box(x - 0.002, x + 0.002, y1 - 0.021, y1 - 0.018, plinth + 0.01, bodyTop - 0.01)));
  }
  for (let i = 0; i < doors; i++) {
    const cx = -w / 2 + leaf * (i + 0.5);
    parts.push(part('metal', box(cx - 0.06, cx + 0.06, y1 - 0.02, y1 - 0.005, bodyTop - 0.06, bodyTop - 0.045)));
  }
  if (top) parts.push(part('worktop', box(-w / 2, w / 2, y0, y1 + 0.01, bodyTop, h)));
  return parts;
}

function tap(x, y, zBase, reach = 0.18, height = 0.28) {
  return [
    part('metal', cylZ(x, y, 0.022, 0.022, zBase, zBase + height, 16)),
    part('metal', box(x - 0.012, x + 0.012, y, y + reach, zBase + height - 0.025, zBase + height)),
  ];
}

// ─── Modèles ──────────────────────────────────────────────────────────────────

const MODELS = {
  wc(w, d, h) {
    const tankD = Math.min(0.18, d * 0.3);
    const seatZ = Math.min(0.42, h * 0.55);
    return [
      part('ceramic', box(-w / 2, w / 2, -d / 2, -d / 2 + tankD, seatZ - 0.05, h)),
      part('ceramic', cylZ(0, -d / 2 + tankD + 0.02, w * 0.22, 0.10, 0, seatZ - 0.04)),
      part('ceramic', cylZ(0, tankD / 2, w / 2, (d - tankD) / 2 - 0.002, seatZ - 0.12, seatZ - 0.02)),
      part('linen', cylZ(0, tankD / 2, w / 2 - 0.005, (d - tankD) / 2 - 0.008, seatZ - 0.02, seatZ)),
      part('dark', cylZ(0, tankD / 2 + 0.02, w * 0.3, (d - tankD) * 0.3, seatZ, seatZ + 0.002)),
      part('metal', box(-0.04, 0.04, -d / 2 + tankD * 0.3, -d / 2 + tankD * 0.7, h, h + 0.008)),
    ];
  },

  basin(w, d, h) {
    const topZ = h;
    return [
      part('ceramic', cylZ(0, -d / 2 + 0.12, 0.09, 0.07, 0, topZ - 0.15)),
      part('ceramic', box(-w / 2, w / 2, -d / 2, d / 2 - 0.1, topZ - 0.16, topZ)),
      part('ceramic', cylZ(0, d / 2 - 0.12, w / 2, 0.12, topZ - 0.16, topZ)),
      part('dark', cylZ(0, 0.02, w * 0.36, d * 0.3, topZ, topZ + 0.002)),
      ...tap(0, -d / 2 + 0.05, topZ, 0.1, 0.16),
    ];
  },

  vanity(w, d, h) {
    const topZ = h;
    return [
      part('cabinet', box(-w / 2, w / 2, -d / 2, d / 2 - 0.02, 0.18, topZ - 0.03)),
      part('dark', box(-0.002, 0.002, d / 2 - 0.021, d / 2 - 0.018, 0.2, topZ - 0.05)),
      part('ceramic', box(-w / 2, w / 2, -d / 2, d / 2, topZ - 0.03, topZ)),
      part('dark', cylZ(0, 0.03, w * 0.3, d * 0.28, topZ, topZ + 0.002)),
      ...tap(0, -d / 2 + 0.05, topZ, 0.1, 0.18),
    ];
  },

  shower(w, d, h) {
    const tray = 0.04;
    return [
      part('ceramic', box(-w / 2, w / 2, -d / 2, d / 2, 0, tray)),
      part('dark', cylZ(0, 0, 0.05, 0.05, tray, tray + 0.002)),
      part('glass', box(-w / 2, w / 2 - 0.3, d / 2 - 0.008, d / 2, tray, h)),
      part('glass', box(w / 2 - 0.008, w / 2, -d / 2, d / 2, tray, h)),
      part('metal', cylZ(-w / 2 + 0.06, -d / 2 + 0.05, 0.012, 0.012, tray, Math.min(h, 2.1))),
      part('metal', cylZ(-w / 2 + 0.06, -d / 2 + 0.2, 0.1, 0.1, Math.min(h, 2.1) - 0.02, Math.min(h, 2.1))),
      part('metal', box(-w / 2 + 0.05, -w / 2 + 0.07, -d / 2 + 0.05, -d / 2 + 0.2, Math.min(h, 2.1) - 0.02, Math.min(h, 2.1))),
    ];
  },

  bath(w, d, h) {
    const rim = 0.07, floor = 0.12;
    return [
      part('ceramic', box(-w / 2, w / 2, -d / 2, -d / 2 + rim, 0, h)),
      part('ceramic', box(-w / 2, w / 2, d / 2 - rim, d / 2, 0, h)),
      part('ceramic', box(-w / 2, -w / 2 + rim, -d / 2 + rim, d / 2 - rim, 0, h)),
      part('ceramic', box(w / 2 - rim, w / 2, -d / 2 + rim, d / 2 - rim, 0, h)),
      part('ceramic', box(-w / 2 + rim, w / 2 - rim, -d / 2 + rim, d / 2 - rim, 0, floor)),
      part('dark', cylZ(-w / 2 + 0.2, 0, 0.025, 0.025, floor, floor + 0.002)),
      ...tap(-w / 2 + 0.035, 0, h, 0.12, 0.12),
    ];
  },

  sink(w, d, h) {
    // La hauteur est celle du plan de travail : le robinet vient en plus, sans déformer l'ensemble.
    const parts = kitchenBase(w, d, h, { doors: w > 0.7 ? 2 : 1 });
    const bw = Math.min(w - 0.16, 0.5), bd = Math.min(d - 0.18, 0.42);
    parts.push(part('metal', box(-w / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.05, d / 2 - 0.03, h, h + 0.004)));
    parts.push(part('dark', box(-bw / 2, bw / 2, -bd / 2 + 0.03, bd / 2 + 0.03, h + 0.004, h + 0.006)));
    parts.push(...tap(0, -d / 2 + 0.08, h, 0.2, 0.3));
    return parts;
  },

  baseCabinet(w, d, h) {
    return kitchenBase(w, d, h, { doors: w > 0.7 ? 2 : 1 });
  },

  worktop(w, d, h) {
    return kitchenBase(w, d, h, { doors: Math.max(1, Math.round(w / 0.6)) });
  },

  wallCabinet(w, d, h) {
    const doors = w > 0.7 ? 2 : 1;
    const parts = [part('cabinet', box(-w / 2, w / 2, -d / 2, d / 2, 0, h))];
    const leaf = w / doors;
    for (let i = 1; i < doors; i++) {
      const x = -w / 2 + leaf * i;
      parts.push(part('dark', box(x - 0.002, x + 0.002, d / 2, d / 2 + 0.002, 0.01, h - 0.01)));
    }
    for (let i = 0; i < doors; i++) {
      const cx = -w / 2 + leaf * (i + 0.5);
      parts.push(part('metal', box(cx - 0.06, cx + 0.06, d / 2, d / 2 + 0.015, 0.04, 0.055)));
    }
    return parts;
  },

  cooktop(w, d, h) {
    const parts = kitchenBase(w, d, h, { doors: 1 });
    const pw = Math.min(w - 0.06, 0.58), pd = Math.min(d - 0.08, 0.51);
    parts.push(part('dark', box(-pw / 2, pw / 2, -pd / 2, pd / 2, h, h + 0.006)));
    const r = Math.min(pw, pd) * 0.16;
    for (const x of [-pw * 0.25, pw * 0.25]) for (const y of [-pd * 0.25, pd * 0.25]) {
      parts.push(part('metal', cylZ(x, y, r, r, h + 0.006, h + 0.007)));
    }
    return parts;
  },

  oven(w, d, h) {
    const parts = kitchenBase(w, d, h, { doors: 1 });
    parts.push(part('dark', box(-w / 2 + 0.03, w / 2 - 0.03, d / 2 - 0.02, d / 2 - 0.005, 0.2, h - 0.12)));
    parts.push(part('metal', box(-w / 2 + 0.08, w / 2 - 0.08, d / 2 - 0.005, d / 2 + 0.02, h - 0.16, h - 0.145)));
    return parts;
  },

  dishwasher(w, d, h) {
    const parts = [
      part('dark', box(-w / 2 + 0.01, w / 2 - 0.01, -d / 2, d / 2 - 0.06, 0, 0.1)),
      part('appliance', box(-w / 2, w / 2, -d / 2, d / 2 - 0.02, 0.1, h - 0.03)),
      part('worktop', box(-w / 2, w / 2, -d / 2, d / 2 + 0.01, h - 0.03, h)),
      part('dark', box(-w / 2 + 0.03, w / 2 - 0.03, d / 2 - 0.02, d / 2 - 0.015, h - 0.12, h - 0.08)),
    ];
    return parts;
  },

  fridge(w, d, h) {
    const split = h * 0.62;
    return [
      part('appliance', box(-w / 2, w / 2, -d / 2, d / 2, 0, h)),
      part('dark', box(-w / 2 + 0.005, w / 2 - 0.005, d / 2, d / 2 + 0.002, split - 0.004, split + 0.004)),
      part('metal', box(w / 2 - 0.07, w / 2 - 0.05, d / 2, d / 2 + 0.04, split + 0.1, split + 0.45)),
      part('metal', box(w / 2 - 0.07, w / 2 - 0.05, d / 2, d / 2 + 0.04, split - 0.35, split - 0.1)),
    ];
  },

  hood(w, d, h) {
    const chimney = Math.min(0.28, w * 0.45);
    return [
      part('metal', box(-w / 2, w / 2, -d / 2, d / 2, 0, 0.08)),
      part('metal', box(-chimney / 2, chimney / 2, -d / 2, -d / 2 + chimney * 0.9, 0.08, h)),
    ];
  },

  washer(w, d, h) {
    return [
      part('appliance', box(-w / 2, w / 2, -d / 2, d / 2, 0, h)),
      part('dark', cylY(0, h * 0.45, Math.min(w, h) * 0.24, d / 2, d / 2 + 0.02)),
      part('glass', cylY(0, h * 0.45, Math.min(w, h) * 0.19, d / 2 + 0.02, d / 2 + 0.03)),
      part('dark', box(-w / 2 + 0.03, w / 2 - 0.03, d / 2, d / 2 + 0.005, h - 0.1, h - 0.04)),
    ];
  },

  bed(w, d, h) {
    const frame = Math.max(0.25, h - 0.22), mattress = h;
    const head = Math.min(1.0, h + 0.5);
    const parts = [
      part('wood', box(-w / 2, w / 2, -d / 2, d / 2, 0.12, frame)),
      part('wood', box(-w / 2 + 0.03, -w / 2 + 0.09, d / 2 - 0.09, d / 2 - 0.03, 0, 0.12)),
      part('wood', box(w / 2 - 0.09, w / 2 - 0.03, d / 2 - 0.09, d / 2 - 0.03, 0, 0.12)),
      part('wood', box(-w / 2, w / 2, -d / 2, -d / 2 + 0.06, 0, head)),
      part('linen', box(-w / 2 + 0.02, w / 2 - 0.02, -d / 2 + 0.06, d / 2 - 0.02, frame, mattress)),
      part('fabric', box(-w / 2 + 0.01, w / 2 - 0.01, -d / 2 + 0.55, d / 2 - 0.01, mattress, mattress + 0.05)),
    ];
    const pillows = w > 1.2 ? 2 : 1;
    const pw = (w - 0.1) / pillows - 0.05;
    for (let i = 0; i < pillows; i++) {
      const cx = -w / 2 + 0.05 + (pw + 0.05) * i + pw / 2 + 0.025;
      parts.push(part('linen', box(cx - pw / 2, cx + pw / 2, -d / 2 + 0.1, -d / 2 + 0.45, mattress, mattress + 0.12)));
    }
    return parts;
  },

  sofa(w, d, h) {
    const seat = 0.44, arm = 0.18;
    const cushions = Math.max(1, Math.round((w - 2 * arm) / 0.65));
    const cw = (w - 2 * arm) / cushions;
    const parts = [
      part('fabric', box(-w / 2, w / 2, -d / 2, d / 2, 0.08, seat - 0.12)),
      part('fabric', box(-w / 2, w / 2, -d / 2, -d / 2 + 0.22, seat - 0.12, h)),
      part('fabric', box(-w / 2, -w / 2 + arm, -d / 2, d / 2, seat - 0.12, seat + 0.2)),
      part('fabric', box(w / 2 - arm, w / 2, -d / 2, d / 2, seat - 0.12, seat + 0.2)),
    ];
    for (let i = 0; i < cushions; i++) {
      const x0 = -w / 2 + arm + cw * i + 0.01;
      parts.push(part('linen', box(x0, x0 + cw - 0.02, -d / 2 + 0.22, d / 2 - 0.02, seat - 0.12, seat)));
    }
    for (const x of [-w / 2 + 0.06, w / 2 - 0.06]) for (const y of [-d / 2 + 0.06, d / 2 - 0.06]) {
      parts.push(part('dark', cylZ(x, y, 0.025, 0.025, 0, 0.08, 12)));
    }
    return parts;
  },

  table(w, d, h) {
    const t = 0.035, leg = 0.05, inset = 0.06;
    const parts = [part('wood', box(-w / 2, w / 2, -d / 2, d / 2, h - t, h))];
    for (const x of [-w / 2 + inset, w / 2 - inset - leg]) for (const y of [-d / 2 + inset, d / 2 - inset - leg]) {
      parts.push(part('wood', box(x, x + leg, y, y + leg, 0, h - t)));
    }
    return parts;
  },

  chair(w, d, h) {
    const seat = 0.45, leg = 0.035;
    const parts = [
      part('wood', box(-w / 2, w / 2, -d / 2, d / 2, seat - 0.04, seat)),
      part('wood', box(-w / 2, w / 2, -d / 2, -d / 2 + 0.03, seat, h)),
    ];
    for (const x of [-w / 2, w / 2 - leg]) for (const y of [-d / 2, d / 2 - leg]) {
      parts.push(part('wood', box(x, x + leg, y, y + leg, 0, seat - 0.04)));
    }
    return parts;
  },

  desk(w, d, h) {
    const t = 0.03;
    return [
      part('wood', box(-w / 2, w / 2, -d / 2, d / 2, h - t, h)),
      part('wood', box(-w / 2, -w / 2 + 0.03, -d / 2, d / 2, 0, h - t)),
      part('wood', box(w / 2 - 0.03, w / 2, -d / 2, d / 2, 0, h - t)),
      part('wood', box(-w / 2 + 0.03, w / 2 - 0.03, -d / 2, -d / 2 + 0.02, h - 0.4, h - t)),
    ];
  },

  wardrobe(w, d, h) {
    const doors = Math.max(1, Math.round(w / 0.5));
    const leaf = w / doors;
    const parts = [
      part('dark', box(-w / 2 + 0.01, w / 2 - 0.01, -d / 2, d / 2 - 0.04, 0, 0.08)),
      part('wood', box(-w / 2, w / 2, -d / 2, d / 2, 0.08, h)),
    ];
    for (let i = 1; i < doors; i++) {
      const x = -w / 2 + leaf * i;
      parts.push(part('dark', box(x - 0.002, x + 0.002, d / 2, d / 2 + 0.002, 0.1, h - 0.02)));
    }
    for (let i = 0; i < doors; i++) {
      const x = -w / 2 + leaf * (i + (i % 2 ? 0.12 : 0.88));
      parts.push(part('metal', box(x - 0.008, x + 0.008, d / 2, d / 2 + 0.025, h * 0.45, h * 0.6)));
    }
    return parts;
  },

  radiator(w, d, h) {
    const parts = [];
    const n = Math.max(3, Math.round(w / 0.06));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (w / n) * (i + 0.5);
      parts.push(part('appliance', box(x - 0.02, x + 0.02, -d / 2, d / 2, 0, h)));
    }
    parts.push(part('appliance', box(-w / 2, w / 2, -d / 2 + 0.01, d / 2 - 0.01, h - 0.05, h - 0.02)));
    parts.push(part('appliance', box(-w / 2, w / 2, -d / 2 + 0.01, d / 2 - 0.01, 0.02, 0.05)));
    return parts;
  },

  towelDryer(w, d, h) {
    const parts = [
      part('appliance', box(-w / 2, -w / 2 + 0.03, -d / 2, d / 2, 0, h)),
      part('appliance', box(w / 2 - 0.03, w / 2, -d / 2, d / 2, 0, h)),
    ];
    const bars = Math.max(4, Math.round(h / 0.1));
    for (let i = 0; i < bars; i++) {
      const z = 0.05 + ((h - 0.1) / (bars - 1)) * i;
      parts.push(part('appliance', cylX(0, z, 0.012, -w / 2 + 0.03, w / 2 - 0.03)));
    }
    return parts;
  },
};

/**
 * Parties d'un équipement dans son repère local.
 * @returns [{ mat, mesh: { positions: [[x,y,z]], triangles: [[i,j,k]] } }]
 */
export function equipmentParts(item) {
  const make = MODELS[item.model || item.type];
  const w = Math.max(0.05, item.width || 0.6);
  const d = Math.max(0.05, item.depth || 0.6);
  const h = Math.max(0.02, item.height || 0.9);
  if (!make) return [part('cabinet', box(-w / 2, w / 2, -d / 2, d / 2, 0, h))];
  return make(w, d, h);
}

/**
 * Place les parties dans le repère du plan : rotation (degrés, sens du plan), position, altitude.
 * Les maillages rendus ont le même format que ceux de build.js (plan x, y + hauteur z).
 */
export function placeEquipment(item, parts, baseZ) {
  const a = ((item.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const x0 = item.x || 0, y0 = item.y || 0, z0 = baseZ + (item.zOffset || 0);
  return parts.map((p) => ({
    mat: p.mat,
    mesh: {
      positions: p.mesh.positions.map(([x, y, z]) => [x0 + x * c - y * s, y0 + x * s + y * c, z0 + z]),
      triangles: p.mesh.triangles,
    },
  }));
}

export function hasModel(type) {
  return !!MODELS[type];
}
