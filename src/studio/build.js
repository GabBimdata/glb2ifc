// Smelt Studio — transforme le modèle sémantique en éléments constructifs avec géométrie.
// Coordonnées : plan (x, y vers le bas) + z vertical, en mètres.
import * as G from './geometry.js';
import { WALL_TYPES, OPENING_TYPES, ROOF_OPENINGS } from './catalog.js';
import { levelElevation, wallHeight, levelFaces, bodyById, bodyHeight, bodyOutlines, bodyTopLevelIndex } from './model.js';

export { triangulate } from './geometry.js';
const triangulate = G.triangulate;

function unusedTriangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = G.polygonArea(poly) > 0;
  const idx = [...Array(n).keys()];
  if (!ccw) idx.reverse();
  const tris = [];
  const isEar = (i0, i1, i2) => {
    const a = poly[i0], b = poly[i1], c = poly[i2];
    if (G.cross(G.sub(b, a), G.sub(c, b)) <= 1e-12) return false;
    for (const k of idx) {
      if (k === i0 || k === i1 || k === i2) continue;
      const p = poly[k];
      const d1 = G.cross(G.sub(b, a), G.sub(p, a));
      const d2 = G.cross(G.sub(c, b), G.sub(p, b));
      const d3 = G.cross(G.sub(a, c), G.sub(p, c));
      if (d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12) return false;
    }
    return true;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let found = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      if (isEar(i0, i1, i2)) {
        tris.push([i0, i1, i2]);
        idx.splice(i, 1);
        found = true;
        break;
      }
    }
    if (!found) {
      // polygone dégénéré : éventail de secours
      for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
      return ccw ? tris : tris.map(([a, b, c]) => [a, c, b]);
    }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return ccw ? tris : tris.map(([a, b, c]) => [a, c, b]);
}

// Prisme vertical fermé
export function extrude(poly, z0, z1) {
  const P = G.cleanPolygon(poly);
  const n = P.length;
  const positions = [];
  const triangles = [];
  if (n < 3 || z1 - z0 < 1e-6) return { positions, triangles };
  const tri = triangulate(P);
  const up = G.polygonArea(P) > 0;
  for (const p of P) positions.push([p[0], p[1], z0]);
  for (const p of P) positions.push([p[0], p[1], z1]);
  for (const [a, b, c] of tri) {
    triangles.push(up ? [a, c, b] : [a, b, c]);
    triangles.push(up ? [n + a, n + b, n + c] : [n + a, n + c, n + b]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const base = positions.length;
    positions.push([P[i][0], P[i][1], z0], [P[j][0], P[j][1], z0], [P[j][0], P[j][1], z1], [P[i][0], P[i][1], z1]);
    if (up) triangles.push([base, base + 1, base + 2], [base, base + 2, base + 3]);
    else triangles.push([base, base + 2, base + 1], [base, base + 3, base + 2]);
  }
  return { positions, triangles };
}

export function mergeMeshes(list) {
  const positions = [];
  const triangles = [];
  for (const m of list) {
    const off = positions.length;
    positions.push(...m.positions);
    for (const t of m.triangles) triangles.push([t[0] + off, t[1] + off, t[2] + off]);
  }
  return { positions, triangles };
}

// Boîte orientée : centre (plan), direction u (plan), largeur (le long de u), profondeur, z0, z1
function orientedBox(center, u, width, depth, z0, z1, alongOffset = 0, acrossOffset = 0) {
  const v = G.perp(u);
  const c = G.add(G.add(center, G.mul(u, alongOffset)), G.mul(v, acrossOffset));
  const hw = width / 2, hd = depth / 2;
  const poly = [
    G.add(G.add(c, G.mul(u, -hw)), G.mul(v, -hd)),
    G.add(G.add(c, G.mul(u, hw)), G.mul(v, -hd)),
    G.add(G.add(c, G.mul(u, hw)), G.mul(v, hd)),
    G.add(G.add(c, G.mul(u, -hw)), G.mul(v, hd)),
  ];
  return extrude(poly, z0, z1);
}

function openingMesh(op, center, u, wallThickness, zBase) {
  const f = 0.05; // montants
  const depth = Math.min(wallThickness, 0.12);
  const w = op.width, h = op.height;
  const z0 = zBase + op.sill, z1 = z0 + h;
  const frame = [
    orientedBox(center, u, f, depth, z0, z1, -w / 2 + f / 2),
    orientedBox(center, u, f, depth, z0, z1, w / 2 - f / 2),
    orientedBox(center, u, w, depth, z1 - f, z1),
  ];
  if (op.kind === 'window') frame.push(orientedBox(center, u, w, depth, z0, z0 + f));
  const panel = op.kind === 'window'
    ? orientedBox(center, u, w - 2 * f, 0.02, z0 + f, z1 - f)
    : orientedBox(center, u, w - 2 * f, 0.04, z0, z1 - f);
  return { frame: mergeMeshes(frame), panel };
}

/**
 * Regroupe les murs alignés d'un même côté de bâtiment en un seul ouvrage.
 * Un mur coupé par une cloison ou par une refend reste un seul mur côté IFC,
 * les ouvertures étant reportées le long de l'axe complet.
 */
export function mergeWallChains(level, polys) {
  const walls = level.walls.filter((w) => polys.get(w.id));
  const byNode = new Map();
  for (const w of walls) {
    for (const n of [w.a, w.b]) {
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n).push(w);
    }
  }
  const dirOf = (w) => G.norm(G.sub(level.nodes[w.b], level.nodes[w.a]));
  const alignedAt = (w, node) => {
    const list = byNode.get(node) || [];
    const d = dirOf(w);
    const candidates = list.filter((x) => x !== w
      && x.type === w.type
      && Math.abs(x.thickness - w.thickness) < 1e-6
      && Math.abs(G.cross(d, dirOf(x))) < 1e-3
      && Math.abs(G.dot(d, dirOf(x))) > 0.999);
    // une seule continuation possible, sinon on ne fusionne pas
    return candidates.length === 1 ? candidates[0] : null;
  };

  const used = new Set();
  const chains = [];
  for (const w of walls) {
    if (used.has(w.id)) continue;
    const chain = [w];
    used.add(w.id);
    // on remonte vers le départ
    let cur = w, node = w.a;
    while (true) {
      const next = alignedAt(cur, node);
      if (!next || used.has(next.id)) break;
      used.add(next.id);
      chain.unshift(next);
      node = next.a === node ? next.b : next.a;
      cur = next;
    }
    // puis vers l'arrivée
    cur = w; node = w.b;
    while (true) {
      const next = alignedAt(cur, node);
      if (!next || used.has(next.id)) break;
      used.add(next.id);
      chain.push(next);
      node = next.a === node ? next.b : next.a;
      cur = next;
    }
    chains.push(chain);
  }

  const result = [];
  for (const chain of chains) {
    if (chain.length === 1) {
      const w = chain[0];
      result.push({ wall: w, poly: polys.get(w.id), ids: [w.id], merged: false });
      continue;
    }
    // orientation de la chaîne : on part de l'extrémité libre
    const first = chain[0], second = chain[1];
    let start = (first.a === second.a || first.a === second.b) ? first.b : first.a;
    const nodes = [start];
    const openings = [];
    let cumul = 0;
    for (const w of chain) {
      const from = nodes[nodes.length - 1];
      const to = w.a === from ? w.b : w.a;
      const L = G.dist(level.nodes[from], level.nodes[to]);
      for (const o of w.openings || []) {
        const offset = w.a === from ? o.offset : L - o.offset;
        openings.push({ ...o, offset: cumul + offset });
      }
      cumul += L;
      nodes.push(to);
    }
    const end = nodes[nodes.length - 1];
    const pieces = chain.map((w) => polys.get(w.id));
    const hull = G.convexHullUV(pieces.flat());
    const sum = pieces.reduce((a, p) => a + Math.abs(G.polygonArea(p)), 0);
    if (!hull.length || Math.abs(Math.abs(G.polygonArea(hull)) - sum) > sum * 0.02) {
      // la fusion déformerait la géométrie (angle, décroché) : on garde les murs séparés
      for (const w of chain) result.push({ wall: w, poly: polys.get(w.id), ids: [w.id], merged: false });
      continue;
    }
    result.push({
      wall: { ...chain[0], id: chain[0].id, a: start, b: end, openings },
      poly: hull,
      ids: chain.map((w) => w.id),
      merged: true,
    });
  }
  return result;
}

/**
 * Emprises des ouvertures de toiture d'un corps, sur un niveau donné.
 * Une fenêtre de toit est posée par sa hauteur d'allège au-dessus du plancher :
 * on la fait glisser le long de la pente jusqu'à cette hauteur.
 */
export function roofOpenings(project, level, body) {
  const items = (body.roofItems || []).filter((it) => it.level === level.id || !it.level);
  if (!items.length || !body.roof?.enabled) return [];
  const z = levelElevation(project, level.id);
  const floorZ = z + (body.elevation || 0);
  const baseZ = floorZ + bodyHeight(project, level, body);
  const outlines = bodyOutlines(project, level, body.id, 1);
  const out = [];
  outlines.forEach((outline, k) => {
    const roof = G.buildRoof(outline, { ...body.roof, baseZ });
    const tv = roof.thicknessV || body.roof.thickness;
    for (const item of items) {
      if (out.some((o) => o.item === item && o.ok)) continue;
      const anchor = [item.x, item.y];
      const face = roof.faces.find((f) => G.pointInPolygon(anchor, f.poly.map((p) => [p[0], p[1]])));
      if (!face) continue;
      const zAt = G.planeOf(face.poly);
      if (!zAt) continue;
      const g = [zAt([anchor[0] + 1, anchor[1]]) - zAt(anchor), zAt([anchor[0], anchor[1] + 1]) - zAt(anchor)];
      const slope = G.len(g);
      const u = slope > 1e-4 ? G.norm(g) : [1, 0];
      const v = G.perp(u);
      const horiz = item.height / Math.sqrt(1 + slope * slope);
      const facePoly = face.poly.map((p) => [p[0], p[1]]);
      const preset = ROOF_OPENINGS[item.type] || ROOF_OPENINGS.skylight;

      if (preset.kind === 'dormer') {
        // repère du pan : U vers le haut de la pente, V le long de l'égout
        const U = u, V = v;
        const us = facePoly.map((p) => G.dot(G.sub(p, anchor), U));
        const uMin = Math.min(...us);
        const uFront = uMin + (item.setback ?? preset.setback);
        const origin = G.add(anchor, G.mul(U, uFront));
        const toWorld = (p) => G.add(G.add(origin, G.mul(U, p[0])), G.mul(V, p[1]));
        const zOrigin = zAt(origin);
        const d = G.buildDormer({
          type: preset.dormer,
          width: item.width ?? preset.width,
          wallHeight: item.wallHeight ?? preset.wallHeight,
          pitch: item.pitch ?? preset.pitch,
          depth: item.depth ?? preset.depth,
          slope,
          window: { height: item.winHeight ?? preset.winHeight, sill: item.winSill ?? preset.winSill },
        });
        const holeWorld = d.hole.map(toWorld);
        const ok2 = holeWorld.every((p) => G.pointInPolygon(p, facePoly));
        const map = (mesh) => ({
          positions: mesh.positions.map((q) => { const w2 = toWorld([q[0], q[1]]); return [w2[0], w2[1], zOrigin + q[2]]; }),
          triangles: mesh.triangles,
        });
        const groups = {};
        for (const part of d.parts) {
          (groups[part.kind] ||= []).push(map(part.mesh));
        }
        out.push({
          item, preset, dormer: d, poly: holeWorld, u: U, v: V, zAt, tv, ok: ok2, clamped: false,
          outlineIndex: k, partIndex: face.part,
          groups, origin, zOrigin,
          sillZ: zOrigin + (item.winSill ?? preset.winSill), floorZ, body,
          hostKey: `roof-${body.id}-${k}-${face.part}`,
        });
        continue;
      }

      const rectAt = (t) => {
        const c = G.add(anchor, G.mul(u, t));
        return [
          G.add(G.add(c, G.mul(u, -horiz / 2)), G.mul(v, -item.width / 2)),
          G.add(G.add(c, G.mul(u, horiz / 2)), G.mul(v, -item.width / 2)),
          G.add(G.add(c, G.mul(u, horiz / 2)), G.mul(v, item.width / 2)),
          G.add(G.add(c, G.mul(u, -horiz / 2)), G.mul(v, item.width / 2)),
        ];
      };
      const fits = (t) => rectAt(t).every((p) => G.pointInPolygon(p, facePoly));
      let want = 0;
      if (slope > 1e-4) want = (floorZ + item.sill + tv + (slope * horiz) / 2 - zAt(anchor)) / slope;
      let t = want;
      let ok = fits(t);
      if (!ok) {
        // l'allège demandée sort du pan (sous l'égout ou au-dessus du faîtage) :
        // on place la fenêtre au plus près possible et on annonce la hauteur réellement obtenue.
        const ts = face.poly.map((p) => G.dot(G.sub([p[0], p[1]], anchor), u));
        const lo = Math.min(...ts), hi = Math.max(...ts);
        let best = null;
        for (let i = 0; i <= 120; i++) {
          const cand = lo + ((hi - lo) * i) / 120;
          if (!fits(cand)) continue;
          if (best === null || Math.abs(cand - want) < Math.abs(best - want)) best = cand;
        }
        if (best !== null) { t = best; ok = true; }
      }
      const poly = rectAt(t);
      const clamped = ok && Math.abs(t - want) > 1e-3;
      out.push({
        item, poly, u, v, zAt, tv, ok, clamped, outlineIndex: k, partIndex: face.part,
        sillZ: Math.min(...poly.map((p) => zAt(p))) - tv,
        floorZ, body,
        hostKey: `roof-${body.id}-${k}-${face.part}`,
      });
    }
  });
  for (const item of items) {
    if (!out.some((o) => o.item === item)) out.push({ item, poly: null, ok: false, body, floorZ });
  }
  return out;
}

/**
 * Construit la liste des éléments du bâtiment.
 * Chaque pièce appartient à un corps de bâtiment (altitude du sol, hauteur des murs, toiture propres).
 * options.upToLevelIndex : limite l'affichage aux niveaux inférieurs ou égaux
 */
export function buildElements(project, options = {}) {
  const elements = [];
  const warnings = [];
  const levels = project.levels;
  const lastIndex = options.upToLevelIndex ?? levels.length - 1;
  const slabT = project.settings.slabThickness;
  const mainId = project.bodies[0].id;

  levels.forEach((level, li) => {
    if (li > lastIndex) return;
    const isTopLevel = li === levels.length - 1;
    const z = levelElevation(project, level.id);
    const polys = G.computeWallPolygons(level);
    const { rooms } = levelFaces(level);

    const bodyOfRoom = (room) => bodyById(project, room?.bodyId || mainId);
    const floorOf = (body) => z + (body.elevation || 0);
    const topOf = (body, category) => {
      const h = bodyHeight(project, level, body);
      const cut = category === 'exterior' || isTopLevel ? 0 : slabT;
      return floorOf(body) + h - cut;
    };

    // corps présents sur ce niveau
    const present = [];
    for (const r of rooms) {
      const b = bodyOfRoom(r.room);
      if (!present.includes(b)) present.push(b);
    }
    if (!present.length && level.walls.length) present.push(bodyById(project, mainId));

    // murs → corps voisins
    const wallBodies = new Map();
    for (const r of rooms) {
      const b = bodyOfRoom(r.room);
      for (const id of r.face.wallIds) {
        if (!wallBodies.has(id)) wallBodies.set(id, []);
        if (!wallBodies.get(id).includes(b)) wallBodies.get(id).push(b);
      }
    }

    // Planchers, un par corps et par contour fermé
    for (const body of present) {
      const outlines = bodyOutlines(project, level, body.id, li === 0 ? 1 : -1);
      const zf = floorOf(body);
      outlines.forEach((outline, k) => {
        if (!outline || outline.length < 3) return;
        elements.push({
          kind: 'slab', level, levelIndex: li, body,
          name: `Plancher ${body.name} ${level.name}${outlines.length > 1 ? ` ${k + 1}` : ''}`,
          profile: outline, z0: zf - slabT, depth: slabT,
          mesh: extrude(outline, zf - slabT, zf),
          key: `slab-${level.id}-${body.id}-${k}`,
        });
      });
    }

    // Pièces
    rooms.forEach(({ net, room, area }) => {
      if (!room || net.length < 3) return;
      const body = bodyOfRoom(room);
      const zf = floorOf(body);
      const underCeiling = body.ceiling && bodyTopLevelIndex(project, body.id) === li ? (body.ceilingThickness || 0.15) : 0;
      const ceiling = topOf(body, 'interior') - zf - underCeiling;
      elements.push({
        kind: 'space', level, levelIndex: li, name: room.name, room, area, body,
        profile: net, z0: zf, depth: Math.max(0.5, ceiling),
        key: `space-${room.id}`,
      });
    });

    // Murs : un mur mitoyen monte au plus haut des deux corps
    for (const group of mergeWallChains(level, polys)) {
      const wall = group.wall;
      const poly = group.poly;
      if (!poly || poly.length < 3) continue;
      const a = level.nodes[wall.a], b = level.nodes[wall.b];
      const u = G.norm(G.sub(b, a));
      const type = WALL_TYPES[wall.type] || { label: 'Mur', category: 'interior' };
      const adjacent = [];
      for (const id of group.ids) for (const bd of wallBodies.get(id) || []) if (!adjacent.includes(bd)) adjacent.push(bd);
      const bodies = adjacent.length ? adjacent : [bodyById(project, mainId)];
      const base = Math.min(...bodies.map(floorOf));
      const top = Math.max(...bodies.map((bd) => topOf(bd, type.category)));
      const hw = top - base;
      if (hw <= 0.05) continue;
      const pieces = G.wallPieces(level, wall, poly, hw);
      elements.push({
        kind: 'wall', level, levelIndex: li, wall, wallType: type, body: bodies[0], wallIds: group.ids,
        name: `${type.label} ${wall.id.slice(-4)}`,
        profile: poly, z0: base, depth: hw,
        mesh: mergeMeshes(pieces.map((p) => extrude(p.poly, base + p.z0, base + p.z1))),
        key: `wall-${wall.id}`,
      });
      for (const op of wall.openings || []) {
        const center = G.add(a, G.mul(u, op.offset));
        const { frame, panel } = openingMesh(op, center, u, wall.thickness, base);
        const cat = OPENING_TYPES[op.type];
        elements.push({
          kind: op.kind, level, levelIndex: li, wall, opening: op, body: bodies[0],
          name: `${cat?.label || (op.kind === 'door' ? 'Porte' : 'Fenêtre')} ${op.id.slice(-4)}`,
          center, u, z0: base + op.sill,
          frame, panel,
          voidProfile: { center, u, width: op.width, depth: wall.thickness + 0.02, z0: base + op.sill, height: Math.min(op.height, hw - op.sill) },
          key: `op-${op.id}`,
        });
      }
    }

    // Plafonds : sous la toiture, pour ne pas voir les rampants depuis l'intérieur
    for (const body of present) {
      if (!body.ceiling) continue;
      if (bodyTopLevelIndex(project, body.id) !== li) continue;
      const ep = body.ceilingThickness || 0.15;
      const zTop = floorOf(body) + bodyHeight(project, level, body);
      bodyOutlines(project, level, body.id, -1).forEach((outline, k) => {
        if (!outline || outline.length < 3) return;
        elements.push({
          kind: 'ceiling', level, levelIndex: li, body,
          name: `Plafond ${body.name}${k ? ` ${k + 1}` : ''}`,
          profile: outline, z0: zTop - ep, depth: ep,
          mesh: extrude(outline, zTop - ep, zTop),
          key: `ceil-${level.id}-${body.id}-${k}`,
        });
      });
    }

    // Toiture : chaque corps est couvert au sommet du niveau le plus haut où il existe
    for (const body of present) {
      if (!body.roof?.enabled) continue;
      if (bodyTopLevelIndex(project, body.id) !== li) continue;
      if (li > lastIndex) continue;
      const baseZ = floorOf(body) + bodyHeight(project, level, body);
      const outlines = bodyOutlines(project, level, body.id, 1);
      // épaisseur du mur porteur sous un point donné du contour (pour les pignons)
      const thicknessAt = (p) => {
        let best = null;
        for (const wl of level.walls) {
          const pr = G.projectOnSegment(p, level.nodes[wl.a], level.nodes[wl.b]);
          const gap = Math.abs(pr.d - wl.thickness / 2);
          if (!best || gap < best.gap) best = { gap, thickness: wl.thickness };
        }
        return best && best.gap < 0.35 ? best.thickness : null;
      };
      const thickness = Math.max(0.1, ...level.walls
        .filter((w) => (WALL_TYPES[w.type]?.category) === 'exterior')
        .map((w) => w.thickness));
      const openings = roofOpenings(project, level, body);
      outlines.forEach((outline, k) => {
        const holes = openings.filter((o) => o.ok && o.outlineIndex === k).map((o) => o.poly);
        const roof = G.buildRoof(outline, { ...body.roof, baseZ, wallThickness: thickness, thicknessAt, holes });
        if (roof.warning) warnings.push(`${body.name} : ${roof.warning}`);
        roof.parts.forEach((part, i) => {
          elements.push({
            kind: 'roof', level, levelIndex: li, body,
            name: `${part.name} ${body.name}`,
            mesh: G.orientShell({ positions: part.positions, triangles: part.triangles }),
            profile: part.profile, z0: part.z0, depth: part.depth,
            key: `roof-${body.id}-${k}-${i}`,
          });
        });
        for (const o of openings.filter((x) => x.ok && x.outlineIndex === k && x.preset?.kind === 'dormer')) {
          elements.push({
            kind: 'dormer', level, levelIndex: li, body, roofOpening: o,
            name: `${o.preset.label} ${o.item.id.slice(-4)}`,
            walls: mergeMeshes([...(o.groups.cheek || []), ...(o.groups.front || [])]),
            roofMesh: mergeMeshes(o.groups.roof || []),
            frame: mergeMeshes(o.groups.frame || []),
            panel: mergeMeshes(o.groups.glass || []),
            voidPoly: o.poly,
            voidZ0: Math.min(...o.poly.map((p) => o.zAt(p))) - o.tv - 0.2,
            voidZ1: o.zOrigin + o.dormer.ridgeZ + 0.5,
            hostKey: o.hostKey,
            window: o.dormer.window,
            key: `dormer-${o.item.id}`,
          });
        }
        for (const o of openings.filter((x) => x.ok && x.outlineIndex === k && x.preset?.kind !== 'dormer')) {
          const inset = (dw, dh) => {
            const c = G.mul(G.add(o.poly[0], o.poly[2]), 0.5);
            const halfU = G.dist(o.poly[0], o.poly[1]) / 2 - dh;
            const halfV = G.dist(o.poly[1], o.poly[2]) / 2 - dw;
            return [
              G.add(G.add(c, G.mul(o.u, -halfU)), G.mul(o.v, -halfV)),
              G.add(G.add(c, G.mul(o.u, halfU)), G.mul(o.v, -halfV)),
              G.add(G.add(c, G.mul(o.u, halfU)), G.mul(o.v, halfV)),
              G.add(G.add(c, G.mul(o.u, -halfU)), G.mul(o.v, halfV)),
            ];
          };
          const clear = inset(0.06, 0.06);
          const frames = [];
          for (let i = 0; i < 4; i++) {
            const quad = [o.poly[i], o.poly[(i + 1) % 4], clear[(i + 1) % 4], clear[i]];
            frames.push(G.slopedPrism(quad, o.zAt, -0.12, -0.02));
          }
          elements.push({
            kind: 'skylight', level, levelIndex: li, body, roofOpening: o,
            name: `Fenêtre de toit ${o.item.id.slice(-4)}`,
            frame: mergeMeshes(frames),
            panel: G.slopedPrism(clear, o.zAt, -0.09, -0.07),
            voidPoly: o.poly, voidZ0: o.sillZ - 0.1, voidZ1: Math.max(...o.poly.map((p) => o.zAt(p))) + 0.1,
            hostKey: o.hostKey,
            key: `sky-${o.item.id}`,
          });
        }
        roof.panels.forEach((panel, i) => {
          elements.push({
            kind: 'gable', level, levelIndex: li, body,
            name: `${panel.name || 'Pignon'} ${body.name}`,
            mesh: G.orientShell({ positions: panel.positions, triangles: panel.triangles }),
            key: `gable-${body.id}-${k}-${i}`,
          });
        });
      });
    }
  });

  return { elements, warnings };
}
