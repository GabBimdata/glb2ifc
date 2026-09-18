// Smelt Studio — moteur géométrique pur (aucune dépendance, testable sous Node).
// Convention plan : x vers la droite, y vers le bas, unités en mètres.

export const EPS = 1e-6;

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const perp = (a) => [-a[1], a[0]];

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function polygonCentroid(poly) {
  const A = polygonArea(poly);
  if (Math.abs(A) < EPS) {
    const c = poly.reduce((acc, p) => add(acc, p), [0, 0]);
    return mul(c, 1 / poly.length);
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f;
    cy += (a[1] + b[1]) * f;
  }
  return [cx / (6 * A), cy / (6 * A)];
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function projectOnSegment(p, a, b) {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  if (L2 < EPS) return { t: 0, point: a.slice(), d: dist(p, a) };
  let t = dot(sub(p, a), ab) / L2;
  t = Math.max(0, Math.min(1, t));
  const point = add(a, mul(ab, t));
  return { t, point, d: dist(p, point) };
}

export function segmentIntersection(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const t = cross(sub(c, a), s) / den;
  const u = cross(sub(c, a), r) / den;
  return { t, u, point: add(a, mul(r, t)) };
}

function lineIntersection(p, dir1, q, dir2) {
  const den = cross(dir1, dir2);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(q, p), dir2) / den;
  return add(p, mul(dir1, t));
}

// Point intérieur fiable (centroïde si possible, sinon recherche par balayage).
export function interiorPoint(poly) {
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly)) return c;
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  let best = null, bestW = -1;
  for (let k = 1; k < 20; k++) {
    const y = minY + ((maxY - minY) * k) / 20;
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bestW) { bestW = w; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    }
  }
  return best || c;
}

// ─── Murs : polygones avec jonctions (méthode « à la Sweet Home 3D ») ──────────

function outgoingDirs(level) {
  const byNode = new Map();
  for (const w of level.walls) {
    const a = level.nodes[w.a], b = level.nodes[w.b];
    if (!a || !b || dist(a, b) < EPS) continue;
    const d = norm(sub(b, a));
    if (!byNode.has(w.a)) byNode.set(w.a, []);
    if (!byNode.has(w.b)) byNode.set(w.b, []);
    byNode.get(w.a).push({ wall: w, dir: d, atStart: true });
    byNode.get(w.b).push({ wall: w, dir: mul(d, -1), atStart: false });
  }
  for (const list of byNode.values()) list.sort((m, n) => Math.atan2(m.dir[1], m.dir[0]) - Math.atan2(n.dir[1], n.dir[0]));
  return byNode;
}

/**
 * Pour chaque mur, renvoie son polygone en plan (tableau de points) en tenant compte des jonctions.
 * Le polygone est ordonné : [côté gauche départ → arrivée], nœud d'arrivée, [côté droit arrivée → départ], nœud de départ.
 * « Gauche » = côté perp(dir) du mur orienté a→b.
 */
export function computeWallPolygons(level) {
  const byNode = outgoingDirs(level);
  // corners[wallId] = { startL, startR, endL, endR }
  const corners = new Map();
  const set = (w, key, p) => {
    if (!corners.has(w.id)) corners.set(w.id, {});
    corners.get(w.id)[key] = p;
  };

  // extrémités qui n'incluent pas le point du nœud (murs traversants et murs en T)
  const noNodePoint = new Set();
  for (const [nodeId, list] of byNode) {
    const P = level.nodes[nodeId];
    const n = list.length;
    // paire de murs alignés (mur « traversant ») : on garde la plus épaisse
    let through = null;
    if (n >= 3) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const A = list[i], B = list[j];
          if (Math.abs(cross(A.dir, B.dir)) < 1e-3 && dot(A.dir, B.dir) < 0) {
            const t = Math.min(A.wall.thickness, B.wall.thickness);
            if (!through || t > through.t) through = { i, j, t };
          }
        }
      }
    }
    const isThrough = (k) => through && (k === through.i || k === through.j);
    for (let i = 0; i < n; i++) {
      const cur = list[i];
      const k2 = (i + 1) % n;
      const nxt = list[k2]; // voisin suivant dans le sens des angles croissants
      const hc = cur.wall.thickness / 2;
      const hn = nxt.wall.thickness / 2;
      // Côté « + » (angle croissant) du mur courant : perp(dir) pointe vers les angles croissants
      const pc = perp(cur.dir);
      const pn = perp(nxt.dir);
      const lineCur = add(P, mul(pc, hc));   // côté vers nxt
      const lineNxt = add(P, mul(pn, -hn));  // côté de nxt vers cur
      let corner = null;
      if (n > 1) {
        corner = lineIntersection(lineCur, cur.dir, lineNxt, nxt.dir);
        if (corner && dist(corner, P) > 4 * Math.max(hc, hn, 0.05)) corner = null;
        // angle aigu inversé (intersection derrière le mur) : on ignore
        if (corner && dot(sub(corner, P), cur.dir) < -3 * Math.max(hc, hn)) corner = null;
      }
      // un mur traversant garde une extrémité droite ; son voisin s'arrête sur sa face
      const cCur = isThrough(i) ? lineCur : (corner || lineCur);
      const cNxt = isThrough(k2) ? lineNxt : (corner || lineNxt);
      // Si le mur part du nœud (atStart), dir sortant = dir du mur → côté + = gauche.
      // Sinon dir sortant = -dir du mur → côté + = droite du mur.
      set(cur.wall, cur.atStart ? 'startL' : 'endR', cCur);
      set(nxt.wall, nxt.atStart ? 'startR' : 'endL', cNxt);
    }
    if (through) {
      for (let k = 0; k < n; k++) {
        const prevT = isThrough((k - 1 + n) % n), nextT = isThrough((k + 1) % n);
        if (isThrough(k) || (prevT && nextT)) noNodePoint.add(`${list[k].wall.id}:${list[k].atStart ? 'a' : 'b'}`);
      }
    }
  }

  const result = new Map();
  for (const w of level.walls) {
    const a = level.nodes[w.a], b = level.nodes[w.b];
    if (!a || !b || dist(a, b) < EPS) continue;
    const d = norm(sub(b, a));
    const l = perp(d);
    const h = w.thickness / 2;
    const c = corners.get(w.id) || {};
    const startL = c.startL || add(a, mul(l, h));
    const startR = c.startR || add(a, mul(l, -h));
    const endL = c.endL || add(b, mul(l, h));
    const endR = c.endR || add(b, mul(l, -h));
    const degA = (byNode.get(w.a) || []).length;
    const degB = (byNode.get(w.b) || []).length;
    const poly = [startL, endL];
    if (degB > 1 && !noNodePoint.has(`${w.id}:b`)) poly.push(b.slice());
    poly.push(endR, startR);
    if (degA > 1 && !noNodePoint.has(`${w.id}:a`)) poly.push(a.slice());
    result.set(w.id, cleanPolygon(poly));
  }
  return result;
}

export function cleanPolygon(poly, tol = 1e-5) {
  const out = [];
  for (const p of poly) {
    if (!out.length || dist(out[out.length - 1], p) > tol) out.push(p);
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) <= tol) out.pop();
  // retire les points colinéaires
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const p0 = out[(i - 1 + out.length) % out.length], p1 = out[i], p2 = out[(i + 1) % out.length];
      if (Math.abs(cross(sub(p1, p0), sub(p2, p1))) < 1e-7 && dot(sub(p1, p0), sub(p2, p1)) > 0) {
        out.splice(i, 1); changed = true; break;
      }
    }
  }
  return out;
}

// Découpe d'un polygone par le demi-plan dot(p - origin, dir) >= offset (Sutherland–Hodgman)
export function clipHalfPlane(poly, origin, dir, offset, keepGreater = true) {
  const f = (p) => (dot(sub(p, origin), dir) - offset) * (keepGreater ? 1 : -1);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= -1e-9) out.push(a);
    if ((fa >= -1e-9) !== (fb >= -1e-9)) {
      const t = fa / (fa - fb);
      out.push(add(a, mul(sub(b, a), t)));
    }
  }
  return out;
}

/**
 * Morceaux 3D d'un mur percé d'ouvertures.
 * Retourne [{ poly, z0, z1 }] en coordonnées relatives au niveau.
 */
export function wallPieces(level, wall, poly, height) {
  const a = level.nodes[wall.a], b = level.nodes[wall.b];
  const d = norm(sub(b, a));
  const L = dist(a, b);
  const ops = (wall.openings || [])
    .map((o) => ({ s: o.offset - o.width / 2, e: o.offset + o.width / 2, z0: o.sill, z1: Math.min(o.sill + o.height, height) }))
    .filter((o) => o.e > o.s)
    .sort((m, n) => m.s - n.s);
  if (!ops.length) return [{ poly, z0: 0, z1: height }];
  const pieces = [];
  const slice = (s, e) => {
    let p = poly;
    if (s !== null) p = clipHalfPlane(p, a, d, s, true);
    if (e !== null) p = clipHalfPlane(p, a, d, e, false);
    return p.length >= 3 ? p : null;
  };
  let cursor = null;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const s = Math.max(0, o.s), e = Math.min(L, o.e);
    const full = slice(cursor, s);
    if (full) pieces.push({ poly: full, z0: 0, z1: height });
    const mid = slice(s, e);
    if (mid) {
      if (o.z0 > 0.001) pieces.push({ poly: mid, z0: 0, z1: o.z0 });
      if (o.z1 < height - 0.001) pieces.push({ poly: mid, z0: o.z1, z1: height });
    }
    cursor = e;
  }
  const last = slice(cursor, null);
  if (last) pieces.push({ poly: last, z0: 0, z1: height });
  return pieces;
}

// ─── Graphe planaire : faces = pièces ─────────────────────────────────────────

function pruneDangling(level) {
  const deg = new Map();
  let walls = level.walls.filter((w) => w.a !== w.b && level.nodes[w.a] && level.nodes[w.b]);
  let changed = true;
  while (changed) {
    changed = false;
    deg.clear();
    for (const w of walls) {
      deg.set(w.a, (deg.get(w.a) || 0) + 1);
      deg.set(w.b, (deg.get(w.b) || 0) + 1);
    }
    const kept = walls.filter((w) => deg.get(w.a) > 1 && deg.get(w.b) > 1);
    if (kept.length !== walls.length) { walls = kept; changed = true; }
  }
  return walls;
}

/**
 * Détecte les faces du graphe des murs.
 * Retour : { rooms: [{ nodeIds, wallIds, poly, area }], outers: [{ nodeIds, wallIds, poly }] }
 */
export function detectFaces(level) {
  const walls = pruneDangling(level);
  const half = [];
  const outgoing = new Map();
  for (const w of walls) {
    const e1 = { from: w.a, to: w.b, wall: w, used: false };
    const e2 = { from: w.b, to: w.a, wall: w, used: false };
    e1.twin = e2; e2.twin = e1;
    half.push(e1, e2);
    for (const e of [e1, e2]) {
      const p = level.nodes[e.from], q = level.nodes[e.to];
      e.angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
      if (!outgoing.has(e.from)) outgoing.set(e.from, []);
      outgoing.get(e.from).push(e);
    }
  }
  for (const list of outgoing.values()) list.sort((m, n) => m.angle - n.angle);

  const rooms = [], outers = [];
  for (const start of half) {
    if (start.used) continue;
    const loop = [];
    let e = start, guard = 0;
    while (!e.used && guard++ < 10000) {
      e.used = true;
      loop.push(e);
      // suivant : à l'arrivée, on prend l'arête sortante qui précède immédiatement le retour (tour le plus serré)
      const list = outgoing.get(e.to);
      const idx = list.indexOf(e.twin);
      e = list[(idx - 1 + list.length) % list.length];
    }
    if (loop.length < 3) continue;
    const nodeIds = loop.map((h) => h.from);
    const poly = nodeIds.map((id) => level.nodes[id]);
    const area = polygonArea(poly);
    const face = { nodeIds, wallIds: loop.map((h) => h.wall.id), halfEdges: loop, poly, area };
    if (area > 1e-4) rooms.push(face);
    else if (area < -1e-4) outers.push(face);
  }
  return { rooms, outers };
}

/**
 * Décale un polygone arête par arête. distances[i] s'applique à l'arête i (poly[i] → poly[i+1]).
 * Distance positive = vers la gauche de l'arête (repère y vers le bas : pour une face d'aire > 0, la gauche = l'intérieur).
 */
export function offsetPolygon(poly, distances) {
  const n = poly.length;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const d = norm(sub(b, a));
    const off = mul(perp(d), distances[i]);
    lines.push({ p: add(a, off), d });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n;
    const L0 = lines[j], L1 = lines[i];
    const p = lineIntersection(L0.p, L0.d, L1.p, L1.d);
    const limit = 5 * Math.max(Math.abs(distances[i]), Math.abs(distances[j]), 0.05);
    if (p && dist(p, poly[i]) <= limit) { out.push(p); continue; }
    // arêtes parallèles décalées différemment (mur mitoyen prolongé par un mur extérieur) :
    // on crée un décroché droit au lieu d'une diagonale
    const a = add(poly[i], mul(perp(L0.d), distances[j]));
    const b = add(poly[i], mul(perp(L1.d), distances[i]));
    if (dist(a, b) > 1e-6) out.push(a, b); else out.push(b);
  }
  return cleanPolygon(out);
}

// perp(d) avec y vers le bas : pour une face d'aire positive (formule standard), l'intérieur est du côté perp(d).
export function roomNetPolygon(face) {
  const dists = face.halfEdges.map((h) => h.wall.thickness / 2);
  return offsetPolygon(face.poly, dists);
}

export function outerGrossPolygon(face) {
  // face extérieure (aire < 0) : l'intérieur du bâtiment est à droite → décalage négatif vers l'extérieur ?
  // Pour une face d'aire négative, perp(d) pointe vers l'extérieur du bâtiment.
  const dists = face.halfEdges.map((h) => h.wall.thickness / 2);
  const poly = offsetPolygon(face.poly, dists);
  return poly.slice().reverse(); // renvoyé avec une aire positive
}

// Contour au nu intérieur des murs extérieurs (pour les planchers d'étage).
export function outerNetPolygon(face) {
  const dists = face.halfEdges.map((h) => -h.wall.thickness / 2);
  return offsetPolygon(face.poly, dists).slice().reverse();
}

// ─── Toitures ─────────────────────────────────────────────────────────────────

function rotatePt(p, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

// Triangulation par oreilles d'un polygone simple (renvoie des indices)
export function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = polygonArea(poly) > 0;
  const idx = [...Array(n).keys()];
  if (!ccw) idx.reverse();
  const tris = [];
  const isEar = (i0, i1, i2) => {
    const a = poly[i0], b = poly[i1], c = poly[i2];
    if (cross(sub(b, a), sub(c, b)) <= 1e-12) return false;
    for (const k of idx) {
      if (k === i0 || k === i1 || k === i2) continue;
      const p = poly[k];
      // un pont vers un trou duplique des sommets : un point confondu avec un coin ne bloque pas l'oreille
      if (dist(p, a) < 1e-9 || dist(p, b) < 1e-9 || dist(p, c) < 1e-9) continue;
      if (cross(sub(b, a), sub(p, a)) >= -1e-12 && cross(sub(c, b), sub(p, b)) >= -1e-12 && cross(sub(a, c), sub(p, c)) >= -1e-12) return false;
    }
    return true;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 6000) {
    let found = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      if (isEar(i0, i1, i2)) { tris.push([i0, i1, i2]); idx.splice(i, 1); found = true; break; }
    }
    if (!found) {
      for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
      return ccw ? tris : tris.map(([a, b, c]) => [a, c, b]);
    }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return ccw ? tris : tris.map(([a, b, c]) => [a, c, b]);
}

// Relie chaque trou au contour par un pont, pour obtenir un polygone simple triangulable.
export function bridgeHoles(outer, holes) {
  let poly = outer.map((p) => p.slice());
  for (const raw of holes) {
    let hole = raw.map((p) => p.slice());
    if (polygonArea(hole) * polygonArea(outer) > 0) hole.reverse(); // sens inverse du contour
    let bi = 0, hi = 0, best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      for (let j = 0; j < hole.length; j++) {
        const d = dist(poly[i], hole[j]);
        if (d < best) { best = d; bi = i; hi = j; }
      }
    }
    const bridged = [
      ...poly.slice(0, bi + 1),
      ...hole.slice(hi), ...hole.slice(0, hi + 1),
      ...poly.slice(bi),
    ];
    poly = bridged;
  }
  return poly;
}

// Plan passant par trois points non alignés : renvoie z(x, y)
export function planeOf(face) {
  const [a, b, c] = [face[0], face[1], face[face.length - 1]];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  if (Math.abs(n[2]) < 1e-9) return null;
  return (p) => a[2] - ((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1]) / n[2];
}

// Prisme suivant un plan incliné : polygone en plan, décalages verticaux bas et haut.
export function slopedPrism(polyXY, zFn, dz0, dz1) {
  const P = cleanPolygon(polyXY);
  const positions = [];
  const triangles = [];
  if (P.length < 3) return { positions, triangles };
  const tris = triangulate(P);
  const n = P.length;
  for (const p of P) positions.push([p[0], p[1], zFn(p) + dz0]);
  for (const p of P) positions.push([p[0], p[1], zFn(p) + dz1]);
  for (const [a, b, c] of tris) { triangles.push([a, c, b]); triangles.push([n + a, n + b, n + c]); }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push([i, j, n + j], [i, n + j, n + i]);
  }
  return { positions, triangles };
}

// Solide fermé à partir d'une liste de faces supérieures : on duplique vers le bas.
function shellFromTopFaces(topFaces, outline, zOfTop, thicknessV, holes = []) {
  const positions = [];
  const triangles = [];
  const pushPoly3 = (pts, flip) => {
    const base = positions.length;
    for (const p of pts) positions.push(p);
    for (let i = 1; i + 1 < pts.length; i++) {
      triangles.push(flip ? [base, base + i + 1, base + i] : [base, base + i, base + i + 1]);
    }
  };
  for (const f of topFaces) {
    const xy = f.map((p) => [p[0], p[1]]);
    const mine = (holes || []).filter((h) => pointInPolygon(polygonCentroid(h), xy));
    if (!mine.length) {
      pushPoly3(f, false);
      pushPoly3(f.map((p) => [p[0], p[1], p[2] - thicknessV]), true);
      continue;
    }
    // pan percé : triangulation avec trous, puis tableaux verticaux autour de chaque trou
    const zAt = planeOf(f) || ((p) => zOfTop(p));
    const merged = bridgeHoles(xy, mine);
    const tris = triangulate(merged);
    const base = positions.length;
    for (const p of merged) positions.push([p[0], p[1], zAt(p)]);
    const baseLow = positions.length;
    for (const p of merged) positions.push([p[0], p[1], zAt(p) - thicknessV]);
    for (const [a, b, c] of tris) {
      triangles.push([base + a, base + b, base + c]);
      triangles.push([baseLow + a, baseLow + c, baseLow + b]);
    }
    for (const h of mine) {
      for (let i = 0; i < h.length; i++) {
        const a = h[i], b = h[(i + 1) % h.length];
        const k = positions.length;
        positions.push([a[0], a[1], zAt(a)], [b[0], b[1], zAt(b)], [b[0], b[1], zAt(b) - thicknessV], [a[0], a[1], zAt(a) - thicknessV]);
        triangles.push([k, k + 1, k + 2], [k, k + 2, k + 3]);
      }
    }
  }
  // Flancs : on suit exactement le profil de la toiture en reprenant les sommets des pans
  // (sur un pignon la rive dessine un V renversé) ; les sommets étant partagés, le volume est fermé.
  const vertices = [];
  for (const f of topFaces) for (const p of f) vertices.push(p);
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const ab = sub(b, a);
    const L2 = dot(ab, ab);
    if (L2 < 1e-12) continue;
    const breaks = [{ t: 0, z: null }, { t: 1, z: null }];
    for (const v of vertices) {
      const t = dot(sub([v[0], v[1]], a), ab) / L2;
      if (t <= 1e-6 || t >= 1 - 1e-6) continue;
      const proj = add(a, mul(ab, t));
      if (dist(proj, [v[0], v[1]]) > 1e-6) continue;
      if (!breaks.some((q) => Math.abs(q.t - t) < 1e-6 && Math.abs((q.z ?? v[2]) - v[2]) < 1e-6)) breaks.push({ t, z: v[2] });
    }
    breaks.sort((m, n) => m.t - n.t);
    const at = (q) => {
      const p = add(a, mul(ab, q.t));
      let z = q.z;
      if (z === null || !Number.isFinite(z)) z = zOfTop(p);
      if (!Number.isFinite(z)) z = zOfTop(a);
      return { p, z };
    };
    for (let k = 0; k + 1 < breaks.length; k++) {
      const p0 = at(breaks[k]), p1 = at(breaks[k + 1]);
      const base = positions.length;
      positions.push(
        [p0.p[0], p0.p[1], p0.z], [p1.p[0], p1.p[1], p1.z],
        [p1.p[0], p1.p[1], p1.z - thicknessV], [p0.p[0], p0.p[1], p0.z - thicknessV],
      );
      triangles.push([base, base + 2, base + 1], [base, base + 3, base + 2]);
    }
  }
  return { positions, triangles };
}

function dominantAngle(poly) {
  let best = 0, bestL = -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = dist(a, b);
    if (L > bestL) { bestL = L; best = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  return best;
}

// Redresse un contour presque orthogonal : supprime les micro-décrochés et aligne les arêtes.
export function rectifyAxis(poly, tol = 0.12) {
  let pts = cleanPolygon(poly.map((p) => p.slice()));
  for (let pass = 0; pass < 3; pass++) {
    // aligne chaque arête quasi horizontale ou verticale
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      if (Math.abs(dx) > 1e-9 && Math.abs(dx) <= tol && Math.abs(dy) > Math.abs(dx)) {
        const x = (a[0] + b[0]) / 2; a[0] = x; b[0] = x;
      } else if (Math.abs(dy) > 1e-9 && Math.abs(dy) <= tol && Math.abs(dx) > Math.abs(dy)) {
        const y = (a[1] + b[1]) / 2; a[1] = y; b[1] = y;
      }
    }
    // supprime les baïonnettes : un décroché court entre deux arêtes parallèles de même sens
    // (typiquement 3 à 10 cm, hérités d'épaisseurs de murs différentes ou d'un mur mitoyen)
    for (let i = 0; i < pts.length; i++) {
      const n = pts.length;
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      const jog = dist(p1, p2);
      if (jog > 0.35 || jog < 1e-9) continue;
      const d0 = norm(sub(p1, p0)), d1 = norm(sub(p3, p2));
      if (Math.abs(cross(d0, d1)) > 1e-3 || dot(d0, d1) < 0.999) continue;
      // les deux arêtes voisines sont alignées : on les met sur la même ligne
      const axisX = Math.abs(d0[0]) > Math.abs(d0[1]);
      if (axisX) { const y = (p1[1] + p2[1]) / 2; p1[1] = y; p2[1] = y; }
      else { const x = (p1[0] + p2[0]) / 2; p1[0] = x; p2[0] = x; }
    }
    // supprime les arêtes trop courtes
    const keep = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (dist(a, b) <= tol * 0.6 && pts.length - keep.length > 4) continue;
      keep.push(a);
    }
    pts = cleanPolygon(keep);
    if (pts.length < 4) break;
  }
  return pts;
}

// Décomposition d'un polygone orthogonal (dans son repère local) en rectangles maximaux qui se chevauchent.
function rectCover(localPoly) {
  const xs = [...new Set(localPoly.map((p) => +p[0].toFixed(4)))].sort((a, b) => a - b);
  const ys = [...new Set(localPoly.map((p) => +p[1].toFixed(4)))].sort((a, b) => a - b);
  const nx = xs.length - 1, ny = ys.length - 1;
  const inside = [];
  for (let i = 0; i < nx; i++) {
    inside.push([]);
    for (let j = 0; j < ny; j++) {
      inside[i].push(pointInPolygon([(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2], localPoly));
    }
  }
  const covered = inside.map((col) => col.map(() => false));
  const rects = [];
  const fullRange = (i0, i1, j0, j1) => {
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (!inside[i][j]) return false;
    return true;
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!inside[i][j] || covered[i][j]) continue;
      let best = null, bestArea = -1;
      for (let i0 = i; i0 >= 0 && inside[i0][j]; i0--) {
        for (let i1 = i; i1 < nx && inside[i1][j]; i1++) {
          if (!fullRange(i0, i1, j, j)) break;
          let j0 = j, j1 = j;
          while (j0 > 0 && fullRange(i0, i1, j0 - 1, j0 - 1)) j0--;
          while (j1 < ny - 1 && fullRange(i0, i1, j1 + 1, j1 + 1)) j1++;
          const area = (xs[i1 + 1] - xs[i0]) * (ys[j1 + 1] - ys[j0]);
          if (area > bestArea) { bestArea = area; best = [i0, i1, j0, j1]; }
        }
      }
      const [i0, i1, j0, j1] = best;
      for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) covered[a][b] = true;
      rects.push({ x0: xs[i0], x1: xs[i1 + 1], y0: ys[j0], y1: ys[j1 + 1] });
    }
  }
  // Un décroché de façade ne doit pas produire un pan de toiture à lui seul : on ne retient
  // un rectangle que s'il couvre une surface encore découverte significative.
  const total = Math.abs(polygonArea(localPoly));
  rects.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  const done = inside.map((col) => col.map(() => false));
  const cellsOf = (r) => {
    const out = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (!inside[i][j]) continue;
        if (xs[i] >= r.x0 - 1e-9 && xs[i + 1] <= r.x1 + 1e-9 && ys[j] >= r.y0 - 1e-9 && ys[j + 1] <= r.y1 + 1e-9) out.push([i, j]);
      }
    }
    return out;
  };
  const kept = [];
  for (const r of rects) {
    const cells = cellsOf(r);
    let fresh = 0;
    for (const [i, j] of cells) if (!done[i][j]) fresh += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    const small = Math.min(r.x1 - r.x0, r.y1 - r.y0);
    if (kept.length && (fresh < Math.max(4, total * 0.08) || small < 1.5)) continue;
    for (const [i, j] of cells) done[i][j] = true;
    kept.push(r);
  }
  return kept;
}

function isOrthogonal(localPoly, tol = 0.02) {
  for (let i = 0; i < localPoly.length; i++) {
    const a = localPoly[i], b = localPoly[(i + 1) % localPoly.length];
    if (Math.abs(a[0] - b[0]) > tol && Math.abs(a[1] - b[1]) > tol) return false;
  }
  return true;
}

// Panneau vertical (pignon, mur de comble) entre le haut des murs et le dessous de la toiture.
function infillShell(a, b, zBase, zUnder, thickness, inward) {
  const N = 14;
  const positions = [];
  const triangles = [];
  const out = [], inn = [], tops = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = add(a, mul(sub(b, a), t));
    const q = add(p, mul(inward, thickness));
    const z = zUnder(p);
    out.push(p); inn.push(q); tops.push(z);
  }
  if (Math.max(...tops) <= zBase + 0.02) return null;
  const idx = (arr, i, z) => { positions.push([arr[i][0], arr[i][1], z]); return positions.length - 1; };
  for (let i = 0; i < N; i++) {
    const z0 = Math.max(tops[i], zBase), z1 = Math.max(tops[i + 1], zBase);
    const ob0 = idx(out, i, zBase), ob1 = idx(out, i + 1, zBase);
    const ot0 = idx(out, i, z0), ot1 = idx(out, i + 1, z1);
    const ib0 = idx(inn, i, zBase), ib1 = idx(inn, i + 1, zBase);
    const it0 = idx(inn, i, z0), it1 = idx(inn, i + 1, z1);
    triangles.push([ob0, ob1, ot1], [ob0, ot1, ot0]);          // face extérieure
    triangles.push([ib0, it1, ib1], [ib0, it0, it1]);          // face intérieure
    triangles.push([ot0, ot1, it1], [ot0, it1, it0]);          // arête haute
    triangles.push([ob0, ib1, ob1], [ob0, ib0, ib1]);          // dessous
  }
  // joues
  const capA = [idx(out, 0, zBase), idx(inn, 0, zBase), idx(inn, 0, Math.max(tops[0], zBase)), idx(out, 0, Math.max(tops[0], zBase))];
  const capB = [idx(out, N, zBase), idx(inn, N, zBase), idx(inn, N, Math.max(tops[N], zBase)), idx(out, N, Math.max(tops[N], zBase))];
  triangles.push([capA[0], capA[1], capA[2]], [capA[0], capA[2], capA[3]]);
  triangles.push([capB[0], capB[2], capB[1]], [capB[0], capB[3], capB[2]]);
  return { positions, triangles };
}

/**
 * Génère la toiture.
 * outline : polygone extérieur (aire > 0) du niveau concerné, en plan.
 * opts : { type, pitch (°), overhang (m), thickness (m), baseZ (m), wallThickness (m) }
 * Retour : { parts: [...], panels: [...], ridgeZ, warning }
 */
export function buildRoof(outline, opts) {
  const type = opts.type || 'gable';
  const pitch = ((opts.pitch ?? 35) * Math.PI) / 180;
  const tan = Math.tan(pitch);
  const o = opts.overhang ?? 0.4;
  const t = opts.thickness ?? 0.25;
  const baseZ = opts.baseZ ?? 0;
  const wallT = opts.wallThickness ?? 0.3;
  const out = { parts: [], panels: [], faces: [], ridgeZ: baseZ, warning: null };
  const holes = opts.holes || [];
  if (!outline || outline.length < 3) return out;

  if (type === 'flat') {
    const poly = offsetPolygon(outline, outline.map(() => -o));
    const top = baseZ + t;
    const flatFace = poly.map((p) => [p[0], p[1], top]);
    const shell = shellFromTopFaces([flatFace], poly, () => top, t, holes);
    out.parts.push({ ...shell, name: 'Toit plat', profile: holes.length ? null : poly, z0: baseZ, depth: t });
    out.faces.push({ poly: flatFace, part: out.parts.length - 1 });
    out.ridgeZ = top;
    return out;
  }

  const ang = dominantAngle(outline);
  const raw = outline.map((p) => rotatePt(p, -ang));
  const local = rectifyAxis(raw);
  const toWorld = (p) => [...rotatePt([p[0], p[1]], ang), p[2]];
  const tv = t / Math.cos(pitch);
  const zTops = []; // fonctions z du dessus de toiture, en repère local

  if (type === 'shed') {
    const poly = offsetPolygon(local, local.map(() => -o));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of local) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    // pente sur la plus petite portée, pour éviter des hauteurs déraisonnables
    const alongX = (x1 - x0) < (y1 - y0);
    const lo = alongX ? x1 : y1; // bas de pente
    const sign = alongX ? -1 : -1;
    const zTop = (p) => baseZ + tv + (lo - (alongX ? p[0] : p[1])) * tan;
    const topFace = poly.map((p) => [p[0], p[1], zTop(p)]);
    const shell = shellFromTopFaces([topFace], poly, zTop, tv, holes.map((h) => h.map((q) => rotatePt(q, -ang))));
    shell.positions = shell.positions.map(toWorld);
    out.parts.push({ ...shell, name: 'Toit monopente' });
    out.faces.push({ poly: topFace.map(toWorld), part: out.parts.length - 1 });
    zTops.push(zTop);
  } else {
    let rects;
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const p of local) { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); by0 = Math.min(by0, p[1]); by1 = Math.max(by1, p[1]); }
    const fill = Math.abs(polygonArea(local)) / Math.max(1e-6, (bx1 - bx0) * (by1 - by0));
    if (fill >= 0.85 && !opts.followSetbacks) {
      // emprise presque rectangulaire (une simple encoche, un renfoncement) : une seule toiture,
      // franche, plutôt qu'une succession de pans qui suivent chaque décroché.
      rects = [{ x0: bx0, x1: bx1, y0: by0, y1: by1 }];
    } else if (isOrthogonal(local)) {
      rects = rectCover(local);
    } else {
      rects = [{ x0: bx0, x1: bx1, y0: by0, y1: by1 }];
      out.warning = 'Forme non orthogonale : la toiture est calculée sur le rectangle englobant.';
    }
    rects.forEach((r, idx) => {
      let along = r.x1 - r.x0 >= r.y1 - r.y0; // faîtage parallèle à x ?
      if (opts.ridgeFlip) along = !along;     // quart de tour demandé
      const u0 = along ? r.x0 : r.y0, u1 = along ? r.x1 : r.y1;
      const v0 = along ? r.y0 : r.x0, v1 = along ? r.y1 : r.x1;
      const P = (u, v, z) => (along ? [u, v, z] : [v, u, z]);
      const hw = (v1 - v0) / 2;
      const vm = (v0 + v1) / 2;
      const U0 = u0 - o, U1 = u1 + o, V0 = v0 - o, V1 = v1 + o;
      const zEave = baseZ + tv - o * tan;
      const faces = [];
      let zTop;
      if (type === 'hip') {
        const H = hw + o;
        let r0 = U0 + H, r1 = U1 - H;
        if (r0 > r1) { r0 = r1 = (U0 + U1) / 2; }
        const zR = zEave + Math.min(H, (U1 - U0) / 2) * tan;
        faces.push([P(U0, V0, zEave), P(U1, V0, zEave), P(r1, vm, zR), P(r0, vm, zR)]);
        faces.push([P(U1, V1, zEave), P(U0, V1, zEave), P(r0, vm, zR), P(r1, vm, zR)]);
        faces.push([P(U1, V0, zEave), P(U1, V1, zEave), P(r1, vm, zR)]);
        faces.push([P(U0, V1, zEave), P(U0, V0, zEave), P(r0, vm, zR)]);
        zTop = (p) => {
          const uu = along ? p[0] : p[1], vv = along ? p[1] : p[0];
          if (uu < U0 - 1e-6 || uu > U1 + 1e-6 || vv < V0 - 1e-6 || vv > V1 + 1e-6) return -Infinity;
          return zEave + Math.min(Math.min(vv - V0, V1 - vv), Math.min(uu - U0, U1 - uu)) * tan;
        };
      } else {
        const zRidge = zEave + (hw + o) * tan;
        faces.push([P(U0, V0, zEave), P(U1, V0, zEave), P(U1, vm, zRidge), P(U0, vm, zRidge)]);
        faces.push([P(U1, V1, zEave), P(U0, V1, zEave), P(U0, vm, zRidge), P(U1, vm, zRidge)]);
        zTop = (p) => {
          const uu = along ? p[0] : p[1], vv = along ? p[1] : p[0];
          if (uu < U0 - 1e-6 || uu > U1 + 1e-6 || vv < V0 - 1e-6 || vv > V1 + 1e-6) return -Infinity;
          return zEave + Math.min(vv - V0, V1 - vv) * tan;
        };
      }
      const outlineR = [P(U0, V0, 0), P(U1, V0, 0), P(U1, V1, 0), P(U0, V1, 0)].map((p) => [p[0], p[1]]);
      const shell = shellFromTopFaces(faces, outlineR, zTop, tv, holes.map((h) => h.map((q) => rotatePt(q, -ang))));
      shell.positions = shell.positions.map(toWorld);
      out.parts.push({ ...shell, name: rects.length > 1 ? `Pan de toiture ${idx + 1}` : 'Toiture' });
      for (const f of faces) out.faces.push({ poly: f.map(toWorld), part: out.parts.length - 1 });
      zTops.push(zTop);
    });
  }

  // dessous de toiture (maximum des pans) et panneaux de remplissage sur le contour
  out.thicknessV = tv;
  const zUnderLocal = (p) => {
    let z = -Infinity;
    for (const f of zTops) z = Math.max(z, f(p));
    return (Number.isFinite(z) ? z : baseZ + tv) - tv;
  };
  for (const part of out.parts) for (const p of part.positions) out.ridgeZ = Math.max(out.ridgeZ, p[2]);

  const area = polygonArea(local);
  for (let i = 0; i < local.length; i++) {
    const a = local[i], b = local[(i + 1) % local.length];
    if (dist(a, b) < 0.05) continue;
    const d = norm(sub(b, a));
    const inward = mul(perp(d), area > 0 ? 1 : -1);
    // épaisseur du pignon = celle du mur qui le porte
    const mid = mul(add(a, b), 0.5);
    const midWorld = rotatePt(mid, ang);
    const t = opts.thicknessAt ? opts.thicknessAt(midWorld) : null;
    const shell = infillShell(a, b, baseZ, zUnderLocal, t || wallT, inward);
    if (!shell) continue;
    shell.positions = shell.positions.map(toWorld);
    out.panels.push({ ...shell, name: `Pignon ${out.panels.length + 1}` });
  }
  return out;
}

// Normalise l'orientation des triangles d'un solide fermé pour que les normales pointent vers l'extérieur.
export function orientShell(shell) {
  const P = shell.positions;
  let cx = 0, cy = 0, cz = 0;
  for (const p of P) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= P.length; cy /= P.length; cz /= P.length;
  // volume signé par rapport au centre
  let vol = 0;
  for (const [i, j, k] of shell.triangles) {
    const a = [P[i][0] - cx, P[i][1] - cy, P[i][2] - cz];
    const b = [P[j][0] - cx, P[j][1] - cy, P[j][2] - cz];
    const c = [P[k][0] - cx, P[k][1] - cy, P[k][2] - cz];
    vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (vol < 0) shell.triangles = shell.triangles.map(([i, j, k]) => [i, k, j]);
  return shell;
}


// ─── Lucarnes (jacobines, chiens-assis) ───────────────────────────────────────
// Tout est calculé dans le repère du pan : u vers le haut de la pente, v le long de l'égout,
// z vertical, l'origine étant posée sur la surface du pan (le pan y vaut donc z = s·u).

function clipUV(poly, f) {
  // garde la partie du polygone où f(p) >= 0 (f linéaire)
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= -1e-9) out.push(a);
    if ((fa >= -1e-9) !== (fb >= -1e-9)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out.length >= 3 ? out : null;
}

// Prisme : polygone plan + épaisseur selon un axe, via une fonction de placement.
function prismFrom(poly2, a0, a1, place) {
  const positions = [];
  const triangles = [];
  if (!poly2 || poly2.length < 3) return { positions, triangles };
  const P = cleanPolygon(poly2);
  const n = P.length;
  const tris = triangulate(P);
  for (const p of P) positions.push(place(p, a0));
  for (const p of P) positions.push(place(p, a1));
  for (const [a, b, c] of tris) { triangles.push([a, c, b], [n + a, n + b, n + c]); }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push([i, j, n + j], [i, n + j, n + i]);
  }
  return { positions, triangles };
}

/**
 * Construit une lucarne dans le repère du pan.
 * opts : { type: 'gable'|'hip'|'shed', width, wallHeight, pitch (°), slope (pente du pan, tan),
 *          thickness (joues et façade), roofThickness, window: { height, sill } }
 * Retour : { hole (polygone u,v), parts: [{ mesh, kind }] } — mesh en coordonnées (u, v, z).
 */
export function buildDormer(opts) {
  const type = opts.type || 'gable';
  const w = opts.width ?? 1.6;
  const hW = opts.wallHeight ?? 1.5;
  const tanD = Math.tan(((opts.pitch ?? 40) * Math.PI) / 180);
  const s = Math.max(0.05, opts.slope ?? 0.7);
  const t = opts.thickness ?? 0.12;
  const tr = opts.roofThickness ?? 0.12;
  const w2 = w / 2;
  const parts = [];
  const hR = hW + w2 * tanD;

  // — couverture de la lucarne, découpée par le plan du pan principal —
  const roofSurfaces = [];
  if (type === 'shed') {
    // la profondeur commande : la pente s'en déduit pour que l'arrière meure dans le pan
    const depth = Math.max(0.6, opts.depth ?? 2);
    const tanS = Math.max(0.05, s - hW / depth);
    const zf = (p) => hW + p[0] * tanS;
    roofSurfaces.push({ poly: [[0, -w2], [40, -w2], [40, w2], [0, w2]], zf });
  } else {
    const zRight = (p) => hR - Math.abs(p[1]) * tanD;
    roofSurfaces.push({ poly: [[0, 0], [40, 0], [40, w2], [0, w2]], zf: zRight });
    roofSurfaces.push({ poly: [[0, -w2], [40, -w2], [40, 0], [0, 0]], zf: zRight });
    if (type === 'hip') {
      // croupe avant : plan montant depuis l'égout de la lucarne
      const zHip = (p) => hW + p[0] * tanD;
      roofSurfaces.push({ poly: [[0, -w2], [w2, 0], [0, w2]], zf: zHip });
    }
  }
  const clipped = [];
  for (const surf of roofSurfaces) {
    let poly = surf.poly;
    if (type === 'hip' && surf.zf([0, 0]) === hR) {
      // les longs pans s'arrêtent derrière l'arêtier
      poly = clipUV(poly, (p) => p[0] - (w2 - Math.abs(p[1])));
    }
    poly = poly && clipUV(poly, (p) => surf.zf(p) - s * p[0]); // au-dessus du pan principal
    if (!poly) continue;
    clipped.push({ poly, zf: surf.zf });
    parts.push({ kind: 'roof', mesh: prismFrom(poly, 0, 1, (p, k) => [p[0], p[1], surf.zf(p) - (k ? 0 : tr)]) });
  }

  // — trou dans le pan principal : emprise de ce qui est couvert —
  let hole = [];
  for (const c of clipped) for (const p of c.poly) hole.push(p);
  hole = convexHullUV(hole);

  // — joues —
  const shedTan = Math.max(0.05, s - hW / Math.max(0.6, opts.depth ?? 2));
  const eaveZ = type === 'shed' ? (p) => hW + p[0] * shedTan : () => hW;
  for (const side of [-1, 1]) {
    const uMax = type === 'shed' ? hW / Math.max(0.01, s - shedTan) : hW / s;
    const profile = [];
    const N = 8;
    for (let i = 0; i <= N; i++) { const u = (uMax * i) / N; profile.push([u, eaveZ([u])]); }
    for (let i = N; i >= 0; i--) { const u = (uMax * i) / N; profile.push([u, s * u]); }
    const poly = cleanPolygon(profile);
    parts.push({ kind: 'cheek', mesh: prismFrom(poly, side * w2, side * (w2 - t), (p, v) => [p[0], v, p[1]]) });
  }

  // — façade, avec sa baie —
  const top = type === 'gable'
    ? [[-w2, hW], [0, hR], [w2, hW]]
    : [[-w2, hW], [w2, hW]];
  const win = opts.window || { height: 1.0, sill: 0.5 };
  const wh = Math.min(win.height, hW - win.sill - 0.15);
  const ww = Math.max(0.3, w - 2 * t - 0.3);
  const z0 = win.sill, z1 = win.sill + wh;
  const pieces = [
    [[-w2, 0], [w2, 0], [w2, z0], [-w2, z0]],
    [[-w2, z0], [-ww / 2, z0], [-ww / 2, z1], [-w2, z1]],
    [[ww / 2, z0], [w2, z0], [w2, z1], [ww / 2, z1]],
    [[-w2, z1], [w2, z1], ...top.slice().reverse()],
  ];
  for (const piece of pieces) parts.push({ kind: 'front', mesh: prismFrom(piece, 0, t, (p, u) => [u, p[0], p[1]]) });
  const frame = [
    [[-ww / 2, z0], [ww / 2, z0], [ww / 2, z0 + 0.06], [-ww / 2, z0 + 0.06]],
    [[-ww / 2, z1 - 0.06], [ww / 2, z1 - 0.06], [ww / 2, z1], [-ww / 2, z1]],
    [[-ww / 2, z0], [-ww / 2 + 0.06, z0], [-ww / 2 + 0.06, z1], [-ww / 2, z1]],
    [[ww / 2 - 0.06, z0], [ww / 2, z0], [ww / 2, z1], [ww / 2 - 0.06, z1]],
  ];
  for (const f of frame) parts.push({ kind: 'frame', mesh: prismFrom(f, 0.01, t - 0.01, (p, u) => [u, p[0], p[1]]) });
  parts.push({
    kind: 'glass',
    mesh: prismFrom([[-ww / 2 + 0.05, z0 + 0.05], [ww / 2 - 0.05, z0 + 0.05], [ww / 2 - 0.05, z1 - 0.05], [-ww / 2 + 0.05, z1 - 0.05]],
      t / 2 - 0.01, t / 2 + 0.01, (p, u) => [u, p[0], p[1]]),
  });

  return { hole, parts, ridgeZ: type === 'shed' ? hW + 1 : hR, window: { width: ww, height: wh, sill: win.sill } };
}

// Enveloppe convexe (les emprises de lucarnes sont convexes : rectangle ou pentagone)
export function convexHullUV(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (src) => {
    const out = [];
    for (const p of src) {
      while (out.length >= 2 && cross(sub(out[out.length - 1], out[out.length - 2]), sub(p, out[out.length - 1])) <= 1e-12) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.slice().reverse())];
}
