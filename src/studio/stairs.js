// Smelt Studio : escaliers droits, avec palier ou avec marches rayonnantes.
// Module pur : géométrie en repère du plan (x, y vers le bas) et hauteurs depuis le plancher
// de départ. Partagé par la construction 3D, l'éditeur, l'IFC et les tests.
import * as G from './geometry.js';

export const STAIR_TYPES = {
  straight: 'Droit',
  quarter: 'Quart tournant avec palier',
  winder: 'Quart tournant sans palier',
};

export const isTurningStair = (stair) => stair.type === 'quarter' || stair.type === 'winder';

// Côté de la main courante. Dans un escalier tournant logé dans un angle, les bords
// extérieurs longent les murs : la main courante va côté intérieur (le jour).
// Pour un escalier droit, « inner » est le côté vers lequel pointe `turn` (F pour changer).
export const STAIR_RAILS = { inner: 'Côté jour', outer: 'Côté mur', both: 'Des deux côtés' };
const railSides = (stair) => {
  const r = stair.rail || 'inner';
  return r === 'both' ? [-1, 1] : r === 'outer' ? [-1] : [1];
};

const NEWEL = 0.09; // section des poteaux (départ, pivot, arrivée)

export const STAIR_LIMITS = { flight: 100, winders: 8 };
const count = (value, fallback, min = 0, max = STAIR_LIMITS.flight) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

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
  const risers = count(opts.risers, Math.max(2, Math.round(height / target)), 2, 2 * STAIR_LIMITS.flight + STAIR_LIMITS.winders + 1);
  const riser = height / risers;
  const going = Math.min(0.32, Math.max(0.22, (opts.blondel ?? STAIR_DEFAULTS.blondel) - 2 * riser));
  return { risers, riser, going };
}

// Les anciens projets (flight1 seul) gardent leur nombre de hauteurs automatique.
// Dès que les deux volées sont renseignées, leur somme fixe ce nombre : on ajuste
// la hauteur de marche, jamais la hauteur d'arrivée de l'escalier.
export function stairParameters(stair, height) {
  const automatic = stairRhythm(height);
  if (!isTurningStair(stair)) return { ...automatic, flights: [automatic.risers - 1], turnSteps: 0 };
  const turnSteps = stair.type === 'winder' ? count(stair.winderSteps, 3, 2, STAIR_LIMITS.winders) : 1;
  const available = Math.max(0, automatic.risers - 1 - turnSteps);
  const explicit = Number.isFinite(stair.flight1) && Number.isFinite(stair.flight2);
  const k1 = count(stair.flight1, Math.floor(available / 2), 0, explicit ? STAIR_LIMITS.flight : available);
  const k2 = explicit ? count(stair.flight2, 0) : available - k1;
  return { ...stairRhythm(height, { risers: k1 + turnSteps + k2 + 1 }), flights: [k1, k2], turnSteps };
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
  // (s, z, t) -> (u, v, z) inverse l'orientation ; le profil doit être horaire.
  if (G.polygonArea(P) > 0) P.reverse();
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
function flight({ start, axis, width, treads, z0, riser, going, railSide, rails }) {
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
    const profile = G.clipHalfPlane(
      [[0, top(0) - depth], [0, top(0)], [sEnd, top(sEnd)], [sEnd, top(sEnd) - depth]],
      [0, z0], [0, 1], 0,
    );
    for (const t of [-w2, w2 - 0.04]) {
      parts.push({ key: 'stringer', mesh: profilePrism(profile, t, t + 0.04, ([s, z], tt) => { const q = at(s, tt); return [q[0], q[1], z]; }) });
    }
  }
  // mains courantes : sur le ou les côtés demandés, balustres tous les 11 cm maximum
  const sides = rails || (railSide ? [railSide] : []);
  if (treads > 0) for (const sd of sides) {
    const t = sd > 0 ? w2 - NEWEL / 2 : -w2 + NEWEL / 2;
    const h = STAIR_DEFAULTS.handrail;
    const rail = (s) => z0 + riser + s * slope + h;
    const place = ([s, z], tt) => { const q = at(s, tt); return [q[0], q[1], z]; };
    parts.push({ key: 'rail', mesh: profilePrism([[0, rail(0) - 0.05], [0, rail(0)], [run, rail(run)], [run, rail(run) - 0.05]], t - 0.03, t + 0.03, place) });
    const n = Math.max(1, Math.ceil(run / 0.13));
    for (let i = 1; i < n; i++) {
      const s0 = (run * i) / n;
      const step = Math.min(treads - 1, Math.floor(s0 / going));
      const zb = z0 + (step + 1) * riser;
      const q0 = at(s0 - 0.01, t - 0.01), q1 = at(s0 + 0.01, t + 0.01);
      parts.push({ key: 'rail', mesh: boxUV(Math.min(q0[0], q1[0]), Math.max(q0[0], q1[0]), Math.min(q0[1], q1[1]), Math.max(q0[1], q1[1]), zb, rail(s0) - 0.05) });
    }
  }
  return { parts, run, at, sides };
}

// Quart de carré partagé par des rayons autour du coin intérieur. Le rayon
// rencontre le contour carré, pas un cercle : aucune encoche au coin extérieur.
function winder({ u, width, steps, z0, riser, outerRail = false }) {
  const w2 = width / 2;
  const pivot = [u, w2];
  const corner = [u + width, -w2];
  const at = (a) => {
    const s = Math.sin(a), c = Math.cos(a), r = width / Math.max(s, c);
    return [u + r * s, w2 - r * c];
  };
  const parts = [], lines = [];
  const angles = Array.from({ length: steps + 1 }, (_, i) => i * Math.PI / (2 * steps));
  for (let i = 0; i < steps; i++) {
    const a = angles[i], b = angles[i + 1];
    const poly = [pivot, at(a)];
    if (a < Math.PI / 4 - 1e-9 && b > Math.PI / 4 + 1e-9) poly.push(corner);
    poly.push(at(b));
    const top = z0 + (i + 1) * riser;
    parts.push({ key: 'tread', mesh: G.slopedPrism(poly, () => top, -STAIR_DEFAULTS.tread, 0) });
  }
  for (const a of angles) lines.push([pivot, at(a)]);

  // Limons et main courante suivent les deux bords extérieurs, avec raccord
  // aux rampes des volées droites. Le coin à 45° reste un sommet explicite.
  const edgeAngles = [...new Set([...angles, Math.PI / 4])].sort((a, b) => a - b);
  const railBase = (a) => z0 + (1 + steps * a / (Math.PI / 2)) * riser;
  for (let i = 0; i < edgeAngles.length - 1; i++) {
    const a = edgeAngles[i], b = edgeAngles[i + 1];
    if (b - a < 1e-9) continue;
    const p = at(a), q = at(b), len = G.dist(p, q), d = G.norm(G.sub(q, p)), n = G.perp(d);
    const place = ([s, z], t) => [p[0] + d[0] * s + n[0] * t, p[1] + d[1] * s + n[1] * t, z];
    for (const [key, offset, depth, thickness] of [['stringer', 0.1, 0.3, 0.04], ...(outerRail ? [['rail', STAIR_DEFAULTS.handrail, 0.05, 0.05]] : [])]) {
      const za = railBase(a) + offset, zb = railBase(b) + offset;
      parts.push({ key, mesh: profilePrism([[0, za - depth], [0, za], [len, zb], [len, zb - depth]], 0.005, 0.005 + thickness, place) });
    }
  }
  for (const a of outerRail ? [0, Math.PI / 4, Math.PI / 2] : []) {
    const p = at(a);
    const x = Math.min(u + width - 0.03, Math.max(u + 0.03, p[0]));
    const y = Math.min(w2 - 0.03, Math.max(-w2 + 0.03, p[1]));
    const step = Math.min(steps, Math.floor(steps * a / (Math.PI / 2)) + 1);
    parts.push({ key: 'rail', mesh: boxUV(x - 0.02, x + 0.02, y - 0.02, y + 0.02, z0 + step * riser - STAIR_DEFAULTS.tread, railBase(a) + STAIR_DEFAULTS.handrail) });
  }
  const path = Array.from({ length: 9 }, (_, i) => {
    const a = i * Math.PI / 16;
    return [u + w2 * Math.sin(a), w2 - w2 * Math.cos(a)];
  });
  return { parts, lines, path };
}

// Poteau carré centré sur [u, v], de z0 à z1 (départ, pivot, arrivée)
function newel([u, v], z0, z1) {
  const h = NEWEL / 2;
  return { key: 'rail', mesh: boxUV(u - h, u + h, v - h, v + h, z0, z1) };
}

/**
 * Mise en plan et en volume d'un escalier.
 * stair : { type, x, y (milieu du bord de départ), dir ([dx, dy], sens de montée), width,
 *           turn (1 = à droite, -1 = à gauche), flight1, flight2 (marches droites),
 *           winderSteps (marches rayonnantes, uniquement pour type = 'winder') }
 * height : hauteur à monter (plancher à plancher) ; slabT : épaisseur de la dalle du dessus.
 * Renvoie tout en coordonnées du plan, hauteurs depuis le plancher de départ.
 */
export function stairLayout(stair, height, slabT = 0.2) {
  const { risers, riser, going, flights, turnSteps } = stairParameters(stair, height);
  const width = Number.isFinite(stair.width) ? Math.min(2.5, Math.max(0.6, stair.width)) : STAIR_DEFAULTS.width;
  const w2 = width / 2;
  const turn = stair.turn === -1 ? -1 : 1;
  const direction = stair.dir?.length === 2 && stair.dir.every(Number.isFinite) && G.len(stair.dir) > G.EPS ? stair.dir : [0, -1];
  const U = G.norm(direction);
  const V = G.mul(G.perp(U), turn);
  const O = [stair.x, stair.y];
  const toWorld = ([u, v]) => G.add(G.add(O, G.mul(U, u)), G.mul(V, v));
  const mapMesh = (m) => ({
    positions: m.positions.map(([u, v, z]) => { const w = toWorld([u, v]); return [w[0], w[1], z]; }),
    // Le miroir gauche/droite inverse l'orientation des faces.
    triangles: turn < 0 ? m.triangles.map(([a, b, c]) => [a, c, b]) : m.triangles,
  });

  const treadsTotal = risers - 1;
  const zCut = height - slabT - STAIR_DEFAULTS.headroom; // au-dessus : moins de 2 m sous la dalle
  const parts = [];
  let footprint, tremie, arrival, treadLines = [], path;
  const info = { risers, riser, going, blondel: 2 * riser + going, width, treads: treadsTotal - (stair.type === 'quarter' ? 1 : 0), flights, turnSteps };

  if (isTurningStair(stair)) {
    const [k1, k2] = flights;
    // côté +1 = intérieur du virage pour les deux volées ; -1 = extérieur (murs)
    const sides = railSides(stair);
    const inner = sides.includes(1), outer = sides.includes(-1);
    const f1 = flight({ start: [0, 0], axis: [1, 0], width, treads: k1, z0: 0, riser, going, rails: sides });
    const u1 = f1.run;
    const zTurn = (k1 + turnSteps) * riser;
    const f2 = flight({ start: [u1 + w2, w2], axis: [0, 1], width, treads: k2, z0: zTurn, riser, going, rails: sides });
    const h = STAIR_DEFAULTS.handrail;
    // poteau de départ, au pied de chaque main courante
    for (const sd of sides) parts.push(newel([NEWEL / 2, sd * (w2 - NEWEL / 2)], 0, riser + h + 0.12));
    // poteau au pivot : là où les deux mains courantes intérieures se rejoignent
    if (inner) parts.push(newel([u1 + NEWEL / 2, w2 - NEWEL / 2], 0, zTurn + riser + h + 0.12));
    // poteau d'arrivée
    for (const sd of sides) parts.push(newel([u1 + w2 - sd * (w2 - NEWEL / 2), w2 + f2.run - NEWEL / 2], zTurn, zTurn + (k2 + 1) * riser + h + 0.05));
    parts.push(...f1.parts.map((p) => ({ ...p, flight: 0 })), ...f2.parts.map((p) => ({ ...p, flight: 1 })));
    let turnPath;
    if (stair.type === 'winder') {
      const fan = winder({ u: u1, width, steps: turnSteps, z0: k1 * riser, riser, outerRail: outer });
      parts.push(...fan.parts);
      treadLines.push(...fan.lines);
      turnPath = fan.path;
      info.winderGoing = Math.PI * width / (4 * turnSteps); // ligne de foulée au milieu
    } else {
      parts.push({ key: 'landing', mesh: boxUV(u1, u1 + width, -w2, w2, zTurn - 0.2, zTurn) });
      // garde-corps du palier, seulement sur ses bords extérieurs si on les a demandés
      if (outer) {
        parts.push({ key: 'rail', mesh: boxUV(u1, u1 + width, -w2 + 0.005, -w2 + 0.055, zTurn + h - 0.05, zTurn + h) });
        parts.push({ key: 'rail', mesh: boxUV(u1 + width - 0.055, u1 + width - 0.005, -w2, w2, zTurn + h - 0.05, zTurn + h) });
        parts.push(newel([u1 + width - NEWEL / 2, -w2 + NEWEL / 2], zTurn - 0.2, zTurn + h + 0.05));
      }
      treadLines.push([[u1, -w2], [u1, w2]], [[u1, w2], [u1 + width, w2]]);
      turnPath = [[u1, 0], [u1 + w2, 0], [u1 + w2, w2]];
    }
    const v2end = w2 + f2.run;
    footprint = [[0, -w2], [u1 + width, -w2], [u1 + width, v2end], [u1, v2end], [u1, w2], [0, w2]];
    for (let i = 1; i < k1; i++) treadLines.push([[i * going, -w2], [i * going, w2]]);
    for (let j = 1; j <= k2; j++) treadLines.push([[u1, w2 + j * going], [u1 + width, w2 + j * going]]);
    path = [...(k1 ? [[going / 2, 0]] : []), ...turnPath, ...(k2 ? [[u1 + w2, v2end - going / 2]] : [])];
    arrival = [[u1, v2end], [u1 + width, v2end]];
    // trémie : depuis la première marche où l'échappée passe sous 2 m, jusqu'à l'arrivée
    const firstLow = (z0, count) => { for (let i = 0; i < count; i++) if (z0 + (i + 1) * riser > zCut) return i; return count; };
    const i1 = firstLow(0, k1);
    if (i1 < k1) {
      const uc = i1 * going - STAIR_DEFAULTS.nosing;
      tremie = [[uc, -w2], [u1 + width, -w2], [u1 + width, v2end], [u1, v2end], [u1, w2], [uc, w2]];
    } else if (zTurn > zCut) {
      // Le carré entier est ouvert si une marche tournante manque d'échappée.
      tremie = [[u1, -w2], [u1 + width, -w2], [u1 + width, v2end], [u1, v2end]];
    } else {
      const i2 = firstLow(zTurn, k2);
      const vc = w2 + i2 * going - STAIR_DEFAULTS.nosing;
      tremie = i2 < k2 ? [[u1, vc], [u1 + width, vc], [u1 + width, v2end], [u1, v2end]] : null;
    }
    info.flights = [k1, k2];
    info.run = [u1 + width, v2end + w2];
  } else {
    const sides = railSides(stair);
    const f = flight({ start: [0, 0], axis: [1, 0], width, treads: treadsTotal, z0: 0, riser, going, rails: sides });
    parts.push(...f.parts.map((p) => ({ ...p, flight: 0 })));
    const L = f.run;
    const h = STAIR_DEFAULTS.handrail;
    for (const sd of sides) {
      parts.push(newel([NEWEL / 2, sd * (w2 - NEWEL / 2)], 0, riser + h + 0.12)); // poteau de départ
      parts.push(newel([L - NEWEL / 2, sd * (w2 - NEWEL / 2)], (treadsTotal) * riser, (treadsTotal + 1) * riser + h + 0.05)); // arrivée
    }
    footprint = [[0, -w2], [L, -w2], [L, w2], [0, w2]];
    for (let i = 1; i <= treadsTotal; i++) treadLines.push([[i * going, -w2], [i * going, w2]]);
    path = [[going / 2, 0], [L - going / 2, 0]];
    arrival = [[L, -w2], [L, w2]];
    let i0 = treadsTotal;
    for (let i = 0; i < treadsTotal; i++) if ((i + 1) * riser > zCut) { i0 = i; break; }
    const uc = i0 * going - STAIR_DEFAULTS.nosing;
    tremie = i0 < treadsTotal ? [[uc, -w2], [L, -w2], [L, w2], [uc, w2]] : null;
    info.flights = [treadsTotal];
    info.run = [L, width];
  }

  // les polygones sont rendus dans le sens positif pour le reste du moteur
  const world = (poly) => { const p = G.cleanPolygon(poly.map(toWorld)); return G.polygonArea(p) > 0 ? p : p.reverse(); };
  return {
    info,
    parts: parts.map((p) => ({ ...p, mesh: mapMesh(p.mesh) })),
    footprint: world(footprint),
    tremie: tremie ? world(tremie) : null,
    arrival: arrival.map(toWorld),
    treadLines: treadLines.map((l) => l.map(toWorld)),
    path: path.map(toWorld),
  };
}
