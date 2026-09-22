// Smelt Studio — escaliers paramétriques (droit, quart tournant avec palier).
// Module pur : géométrie en repère du plan (x, y vers le bas) et hauteurs depuis le plancher
// de départ. Partagé par la construction 3D, l'éditeur, l'IFC et les tests.
import * as G from './geometry.js';

export const STAIR_TYPES = {
  straight: 'Droit',
  quarter: 'Quart tournant',
};

export const STAIR_DEFAULTS = {
  width: 0.9,
  targetRiser: 0.175,   // hauteur de marche visée
  blondel: 0.63,        // 2 h + g
  headroom: 2.0,        // échappée minimale sous la dalle du dessus
  tread: 0.04,          // épaisseur des marches
  nosing: 0.03,         // débord de nez de marche
  handrail: 0.9,        // hauteur de la main courante au-dessus du nez de marche
};

/**
 * Découpage d'une hauteur d'étage en marches confortables (règle de Blondel).
 * Renvoie { risers, riser, going } : le nombre de hauteurs, la hauteur et le giron.
 */
export function stairRhythm(height, opts = {}) {
  const target = opts.targetRiser ?? STAIR_DEFAULTS.targetRiser;
  const risers = Math.max(2, Math.round(height / target));
  const riser = height / risers;
  const going = Math.min(0.32, Math.max(0.22, (opts.blondel ?? STAIR_DEFAULTS.blondel) - 2 * riser));
  return { risers, riser, going };
}

// Boîte orientée dans le repère local (u, v) de l'escalier, z depuis le plancher
function boxUV(u0, u1, v0, v1, z0, z1) {
  const p = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  const positions = [...p.map(([u, v]) => [u, v, z0]), ...p.map(([u, v]) => [u, v, z1])];
  const triangles = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return { positions, triangles };
}

// Prisme dont le profil est dans le plan vertical (s, z) d'une volée, épaisseur selon l'autre axe
function profilePrism(profile, t0, t1, place) {
  const P = G.cleanPolygon(profile);
  const positions = [];
  const triangles = [];
  if (P.length < 3) return { positions, triangles };
  const tri = G.triangulate(P);
  const n = P.length;
  for (const p of P) positions.push(place(p, t0));
  for (const p of P) positions.push(place(p, t1));
  for (const [a, b, c] of tri) triangles.push([a, c, b], [n + a, n + b, n + c]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push([i, j, n + j], [i, n + j, n + i]);
  }
  return { positions, triangles };
}

/**
 * Une volée : marches, limons et main courante.
 * start : [u, v] milieu du bord de départ ; axis : direction de montée (vecteur unité u/v) ;
 * treads : nombre de marches ; z0 : hauteur du sol de départ de la volée.
 */
function flight({ start, axis, width, treads, z0, riser, going, railSide }) {
  const side = [-axis[1], axis[0]]; // perpendiculaire
  const at = (s, t) => [start[0] + axis[0] * s + side[0] * t, start[1] + axis[1] * s + side[1] * t];
  const parts = [];
  const w2 = width / 2;
  const run = treads * going;
  const slope = riser / going;
  // marches (planches avec nez)
  for (let i = 0; i < treads; i++) {
    const s0 = i * going - STAIR_DEFAULTS.nosing, s1 = (i + 1) * going;
    const top = z0 + (i + 1) * riser;
    const a = at(s0, -w2 + 0.04), b = at(s1, w2 - 0.04);
    parts.push({ key: 'tread', mesh: boxUV(Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]), top - STAIR_DEFAULTS.tread, top) });
  }
  // limons : planche inclinée de chaque côté, qui porte les marches
  if (treads > 0) {
    const top = (s) => z0 + riser + s * slope + 0.1;
    const depth = 0.3;
    const sEnd = run;
    const bottomAt0 = top(0) - depth - z0;
    const profile = bottomAt0 >= 0
      ? [[0, z0 + bottomAt0], [0, top(0)], [sEnd, top(sEnd)], [sEnd, top(sEnd) - depth]]
      : [[0, z0], [0, top(0)], [sEnd, top(sEnd)], [sEnd, top(sEnd) - depth], [(-bottomAt0) / slope, z0]];
    for (const t of [-w2, w2 - 0.04]) {
      parts.push({ key: 'stringer', mesh: profilePrism(profile, t, t + 0.04, ([s, z], tt) => { const q = at(s, tt); return [q[0], q[1], z]; }) });
    }
  }
  // main courante du côté libre
  if (railSide && treads > 0) {
    const t = railSide > 0 ? w2 - 0.03 : -w2 + 0.03;
    const h = STAIR_DEFAULTS.handrail;
    const rail = (s) => z0 + riser + s * slope + h;
    const profile = [[0, rail(0) - 0.05], [0, rail(0)], [run, rail(run)], [run, rail(run) - 0.05]];
    parts.push({ key: 'rail', mesh: profilePrism(profile, t - 0.025, t + 0.025, ([s, z], tt) => { const q = at(s, tt); return [q[0], q[1], z]; }) });
    for (const s of [0.05, run - 0.05]) {
      const q0 = at(s - 0.02, t - 0.02), q1 = at(s + 0.02, t + 0.02);
      const zBase = z0 + Math.max(0, Math.ceil(s / going)) * riser;
      parts.push({ key: 'rail', mesh: boxUV(Math.min(q0[0], q1[0]), Math.max(q0[0], q1[0]), Math.min(q0[1], q1[1]), Math.max(q0[1], q1[1]), zBase, rail(s)) });
    }
  }
  return { parts, run };
}

/**
 * Mise en plan et en volume d'un escalier.
 * stair : { type, x, y (milieu du bord de départ), dir ([dx, dy], sens de montée), width,
 *           turn (1 = à droite, -1 = à gauche), flight1 (marches avant le palier) }
 * height : hauteur à monter (plancher à plancher) ; slabT : épaisseur de la dalle du dessus.
 * Renvoie tout en coordonnées du plan, hauteurs depuis le plancher de départ.
 */
export function stairLayout(stair, height, slabT = 0.2) {
  const { risers, riser, going } = stairRhythm(height);
  const width = Math.max(0.6, stair.width || STAIR_DEFAULTS.width);
  const w2 = width / 2;
  const turn = stair.turn === -1 ? -1 : 1;
  const U = G.norm(stair.dir || [0, -1]);
  const V = G.mul(G.perp(U), turn);
  const O = [stair.x, stair.y];
  const toWorld = ([u, v]) => G.add(G.add(O, G.mul(U, u)), G.mul(V, v));
  const mapMesh = (m) => ({ positions: m.positions.map(([u, v, z]) => { const w = toWorld([u, v]); return [w[0], w[1], z]; }), triangles: m.triangles });

  const treadsTotal = risers - 1;
  const zCut = height - slabT - STAIR_DEFAULTS.headroom; // au-dessus : moins de 2 m sous la dalle
  const parts = [];
  let footprint, tremie, arrival, treadLines = [], path;
  const info = { risers, riser, going, blondel: 2 * riser + going, width, treads: treadsTotal };

  if (stair.type === 'quarter') {
    // volée 1, palier carré, volée 2 perpendiculaire (côté du virage)
    const available = treadsTotal - 1; // le palier compte comme une marche
    const k1 = Math.min(available - 1, Math.max(1, stair.flight1 ?? Math.floor(available / 2)));
    const k2 = available - k1;
    const f1 = flight({ start: [0, 0], axis: [1, 0], width, treads: k1, z0: 0, riser, going, railSide: -1 });
    const u1 = f1.run;
    const zLanding = (k1 + 1) * riser;
    const f2 = flight({ start: [u1 + w2, w2], axis: [0, 1], width, treads: k2, z0: zLanding, riser, going, railSide: 1 });
    parts.push(...f1.parts, ...f2.parts);
    parts.push({ key: 'landing', mesh: boxUV(u1, u1 + width, -w2, w2, zLanding - 0.2, zLanding) });
    // garde-corps extérieur du palier
    const h = STAIR_DEFAULTS.handrail;
    parts.push({ key: 'rail', mesh: boxUV(u1, u1 + width, -w2 + 0.005, -w2 + 0.055, zLanding + h - 0.05, zLanding + h) });
    parts.push({ key: 'rail', mesh: boxUV(u1 + width - 0.055, u1 + width - 0.005, -w2, w2, zLanding + h - 0.05, zLanding + h) });
    parts.push({ key: 'rail', mesh: boxUV(u1 + width - 0.05, u1 + width - 0.01, -w2 + 0.01, -w2 + 0.05, zLanding - 0.2, zLanding + h) });
    const v2end = w2 + f2.run;
    footprint = [[0, -w2], [u1 + width, -w2], [u1 + width, v2end], [u1, v2end], [u1, w2], [0, w2]];
    for (let i = 1; i <= k1; i++) treadLines.push([[i * going, -w2], [i * going, w2]]);
    treadLines.push([[u1, -w2], [u1, w2]]);
    for (let j = 0; j <= k2; j++) treadLines.push([[u1, w2 + j * going], [u1 + width, w2 + j * going]]);
    path = [[going / 2, 0], [u1 + w2, 0], [u1 + w2, v2end - going / 2]];
    arrival = [[u1, v2end], [u1 + width, v2end]];
    // trémie : depuis la première marche où l'échappée passe sous 2 m, jusqu'à l'arrivée
    const firstLow = (z0, count) => { for (let i = 0; i < count; i++) if (z0 + (i + 1) * riser > zCut) return i; return count; };
    const i1 = firstLow(0, k1);
    if (i1 < k1) {
      const uc = i1 * going;
      tremie = [[uc, -w2], [u1 + width, -w2], [u1 + width, v2end], [u1, v2end], [u1, w2], [uc, w2]];
    } else if (zLanding > zCut) {
      tremie = [[u1, -w2], [u1 + width, -w2], [u1 + width, v2end], [u1, v2end]];
    } else {
      const i2 = firstLow(zLanding, k2);
      tremie = [[u1, w2 + i2 * going], [u1 + width, w2 + i2 * going], [u1 + width, v2end], [u1, v2end]];
    }
    info.flights = [k1, k2];
    info.run = [u1 + width, v2end + w2];
  } else {
    const f = flight({ start: [0, 0], axis: [1, 0], width, treads: treadsTotal, z0: 0, riser, going, railSide: 1 });
    parts.push(...f.parts);
    const L = f.run;
    footprint = [[0, -w2], [L, -w2], [L, w2], [0, w2]];
    for (let i = 1; i <= treadsTotal; i++) treadLines.push([[i * going, -w2], [i * going, w2]]);
    path = [[going / 2, 0], [L - going / 2, 0]];
    arrival = [[L, -w2], [L, w2]];
    let i0 = treadsTotal;
    for (let i = 0; i < treadsTotal; i++) if ((i + 1) * riser > zCut) { i0 = i; break; }
    tremie = [[i0 * going, -w2], [L, -w2], [L, w2], [i0 * going, w2]];
    info.flights = [treadsTotal];
    info.run = [L, width];
  }

  // les polygones sont rendus dans le sens positif pour le reste du moteur
  const world = (poly) => { const p = poly.map(toWorld); return G.polygonArea(p) > 0 ? p : p.reverse(); };
  return {
    info,
    parts: parts.map((p) => ({ key: p.key, mesh: mapMesh(p.mesh) })),
    footprint: world(footprint),
    tremie: tremie ? world(tremie) : null,
    arrival: arrival.map(toWorld),
    treadLines: treadLines.map((l) => l.map(toWorld)),
    path: path.map(toWorld),
  };
}
