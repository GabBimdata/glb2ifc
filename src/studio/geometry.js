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
    const L0 = lines[(i - 1 + n) % n], L1 = lines[i];
    let p = lineIntersection(L0.p, L0.d, L1.p, L1.d);
    if (!p || dist(p, poly[i]) > 5 * Math.max(Math.abs(distances[i]), Math.abs(distances[(i - 1 + n) % n]), 0.05)) {
      p = L1.p;
    }
    out.push(p);
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

// ─── Toitures ─────────────────────────────────────────────────────────────────

function rotatePt(p, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
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
  // on cherche, pour chaque cellule non couverte, le plus grand rectangle (en surface) qui la contient
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
  return rects;
}

function isOrthogonal(localPoly) {
  for (let i = 0; i < localPoly.length; i++) {
    const a = localPoly[i], b = localPoly[(i + 1) % localPoly.length];
    if (Math.abs(a[0] - b[0]) > 0.005 && Math.abs(a[1] - b[1]) > 0.005) return false;
  }
  return true;
}

// Solide fermé à partir d'une liste de faces supérieures (polygones 3D) : on duplique vers le bas.
// Renvoie { positions: [[x,y,z]...], triangles: [[i,j,k]...] } en repère plan (x,y) + z hauteur.
function shellFromTopFaces(topFaces, outline, zOfTop, thicknessV) {
  const positions = [];
  const triangles = [];
  const pushPoly3 = (pts, flip) => {
    // triangulation en éventail (faces supérieures convexes)
    const base = positions.length;
    for (const p of pts) positions.push(p);
    for (let i = 1; i + 1 < pts.length; i++) {
      triangles.push(flip ? [base, base + i + 1, base + i] : [base, base + i, base + i + 1]);
    }
  };
  for (const f of topFaces) {
    pushPoly3(f, false);
    pushPoly3(f.map((p) => [p[0], p[1], p[2] - thicknessV]), true);
  }
  // rives : quadrilatères verticaux sur le contour
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const za = zOfTop(a), zb = zOfTop(b);
    const base = positions.length;
    positions.push([a[0], a[1], za], [b[0], b[1], zb], [b[0], b[1], zb - thicknessV], [a[0], a[1], za - thicknessV]);
    triangles.push([base, base + 2, base + 1], [base, base + 3, base + 2]);
  }
  return { positions, triangles };
}

/**
 * Génère la toiture.
 * outline : polygone extérieur (aire > 0) du dernier niveau, en plan.
 * opts : { type: 'flat'|'shed'|'gable'|'hip', pitch (°), overhang (m), thickness (m), baseZ (m) }
 * Retour : { parts: [{ positions, triangles, name }], gables: [{ poly, z0, apex... }], warning }
 */
export function buildRoof(outline, opts) {
  const type = opts.type || 'gable';
  const pitch = ((opts.pitch ?? 35) * Math.PI) / 180;
  const tan = Math.tan(pitch);
  const o = opts.overhang ?? 0.4;
  const t = opts.thickness ?? 0.25;
  const baseZ = opts.baseZ ?? 0;
  const out = { parts: [], gables: [], warning: null };
  if (!outline || outline.length < 3) return out;

  if (type === 'flat') {
    const poly = offsetPolygon(outline, outline.map(() => -o));
    const top = baseZ + t;
    const shell = shellFromTopFaces([poly.map((p) => [p[0], p[1], top])], poly, () => top, t);
    out.parts.push({ ...shell, name: 'Toit plat', profile: poly, z0: baseZ, depth: t });
    return out;
  }

  const ang = dominantAngle(outline);
  const local = outline.map((p) => rotatePt(p, -ang));
  const toWorld = (p) => [...rotatePt([p[0], p[1]], ang), p[2]];

  if (type === 'shed') {
    const poly = offsetPolygon(local, local.map(() => -o));
    let minY = Infinity;
    for (const p of local) minY = Math.min(minY, p[1]);
    // pente descendante vers les y croissants du repère local ; bas de pente au mur
    let maxY = -Infinity;
    for (const p of local) maxY = Math.max(maxY, p[1]);
    const zTop = (p) => baseZ + t / Math.cos(pitch) + (maxY - p[1]) * tan;
    const topFace = poly.map((p) => [p[0], p[1], zTop(p)]);
    const shell = shellFromTopFaces([topFace], poly, zTop, t / Math.cos(pitch));
    shell.positions = shell.positions.map(toWorld);
    out.parts.push({ ...shell, name: 'Toit monopente' });
    return out;
  }

  let rects;
  if (isOrthogonal(local)) {
    rects = rectCover(local);
  } else {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of local) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    rects = [{ x0, x1, y0, y1 }];
    out.warning = 'Forme non orthogonale : la toiture est calculée sur le rectangle englobant.';
  }

  const onOutline = (p, q) => {
    // le segment p-q est-il porté par le contour ?
    const m = mul(add(p, q), 0.5);
    for (let i = 0; i < local.length; i++) {
      const pr = projectOnSegment(m, local[i], local[(i + 1) % local.length]);
      if (pr.d < 0.02) return true;
    }
    return false;
  };

  const tv = t / Math.cos(pitch);
  rects.forEach((r, idx) => {
    const along = r.x1 - r.x0 >= r.y1 - r.y0; // faîtage parallèle à x ?
    // on travaille dans un repère où le faîtage est parallèle à u
    const u0 = along ? r.x0 : r.y0, u1 = along ? r.x1 : r.y1;
    const v0 = along ? r.y0 : r.x0, v1 = along ? r.y1 : r.x1;
    const P = (u, v, z) => (along ? [u, v, z] : [v, u, z]);
    const hw = (v1 - v0) / 2;
    const vm = (v0 + v1) / 2;
    const U0 = u0 - o, U1 = u1 + o, V0 = v0 - o, V1 = v1 + o;
    const zEave = baseZ + tv - o * tan;
    const zRidge = baseZ + tv + hw * tan;
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
        const dv = Math.min(vv - V0, V1 - vv), du = Math.min(uu - U0, U1 - uu);
        return zEave + Math.min(dv, du) * tan;
      };
    } else {
      faces.push([P(U0, V0, zEave), P(U1, V0, zEave), P(U1, vm, zRidge), P(U0, vm, zRidge)]);
      faces.push([P(U1, V1, zEave), P(U0, V1, zEave), P(U0, vm, zRidge), P(U1, vm, zRidge)]);
      zTop = (p) => {
        const vv = along ? p[1] : p[0];
        return zEave + Math.min(vv - V0, V1 - vv) * tan;
      };
      // pignons sur les petits côtés portés par le contour
      for (const uEnd of [u0, u1]) {
        const pa = along ? [uEnd, v0] : [v0, uEnd];
        const pb = along ? [uEnd, v1] : [v1, uEnd];
        if (!onOutline(pa, pb)) continue;
        const tri = [P(uEnd, v0, baseZ), P(uEnd, v1, baseZ), P(uEnd, vm, baseZ + hw * tan)];
        out.gables.push({ points: tri.map(toWorld), axisDir: norm(sub(rotatePt(along ? [0, 1] : [1, 0], ang), [0, 0])) });
      }
    }
    // contour de la sous-toiture (orientation cohérente)
    const outlineR = [P(U0, V0, 0), P(U1, V0, 0), P(U1, V1, 0), P(U0, V1, 0)].map((p) => [p[0], p[1]]);
    const shell = shellFromTopFaces(faces, outlineR, zTop, tv);
    shell.positions = shell.positions.map(toWorld);
    out.parts.push({ ...shell, name: rects.length > 1 ? `Pan de toiture ${idx + 1}` : 'Toiture' });
  });
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
