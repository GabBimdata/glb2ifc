// Smelt Studio — transforme le modèle sémantique en éléments constructifs avec géométrie.
// Coordonnées : plan (x, y vers le bas) + z vertical, en mètres.
import * as G from './geometry.js';
import { WALL_TYPES, OPENING_TYPES, ROOF_OPENINGS, BALCONY } from './catalog.js';
import { EQUIPMENT_TYPES } from './equipment-catalog.js';
import { equipmentParts, placeEquipment } from './equipment-models.js';
import { STAIR_TYPES, stairLayout } from './stairs.js';
import { levelElevation, wallHeight, levelFaces, bodyById, bodyHeight, bodyOutlines, bodyTopLevelIndex, isAttic, roofBaseHeight } from './model.js';

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

// Prisme vertical percé (terrasse en anneau autour d'un étage plus petit)
export function extrudeWithHoles(outer, holes, z0, z1) {
  if (!holes?.length) return extrude(outer, z0, z1);
  const merged = G.bridgeHoles(outer, holes);
  const tri = G.triangulate(merged);
  const positions = [];
  const triangles = [];
  const n = merged.length;
  for (const p of merged) positions.push([p[0], p[1], z0]);
  for (const p of merged) positions.push([p[0], p[1], z1]);
  for (const [a, b, c] of tri) triangles.push([a, c, b], [n + a, n + b, n + c]);
  for (const loop of [outer, ...holes]) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      const k = positions.length;
      positions.push([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
      triangles.push([k, k + 1, k + 2], [k, k + 2, k + 3]);
    }
  }
  return { positions, triangles };
}

/**
 * Garde-corps le long du segment p → q, posé à zBase, décalé vers `inward`.
 * Renvoie des parties { mesh, key } : key = clé de couleur (railing, window, exterior).
 */
export function railingParts(p, q, zBase, height, type, inward) {
  const L = G.dist(p, q);
  if (L < 0.05) return [];
  const u = G.norm(G.sub(q, p));
  const parts = [];
  const push = (key, mesh) => parts.push({ key, mesh });
  const inset = type === 'wall' ? 0.075 : 0.05;
  const mid = G.add(G.mul(G.add(p, q), 0.5), G.mul(inward, inset));
  if (type === 'wall') {
    push('exterior', orientedBox(mid, u, L, 0.15, zBase, zBase + height));
    push('railing', orientedBox(mid, u, L, 0.17, zBase + height, zBase + height + 0.03));
    return parts;
  }
  push('railing', orientedBox(mid, u, L, 0.05, zBase + height - 0.05, zBase + height)); // main courante
  const posts = Math.max(2, Math.ceil(L / 1.5) + 1);
  for (let i = 0; i < posts; i++) {
    const t = -L / 2 + 0.03 + ((L - 0.06) * i) / (posts - 1);
    push('railing', orientedBox(mid, u, 0.04, 0.04, zBase, zBase + height - 0.05, t));
  }
  if (type === 'glass') {
    push('window', orientedBox(mid, u, L - 0.08, 0.012, zBase + 0.06, zBase + height - 0.08));
  } else {
    push('railing', orientedBox(mid, u, L, 0.04, zBase + 0.08, zBase + 0.12)); // lisse basse
    const bars = Math.max(1, Math.ceil(L / 0.11)); // vide entre barreaux ≤ 11 cm
    for (let i = 1; i < bars; i++) {
      push('railing', orientedBox(mid, u, 0.018, 0.018, zBase + 0.12, zBase + height - 0.05, -L / 2 + (L * i) / bars));
    }
  }
  return parts;
}

// Terrasses d'un niveau : partie de l'étage du dessous que ce niveau ne couvre pas
export function levelTerraces(project, levelIndex) {
  if (levelIndex <= 0) return [];
  const level = project.levels[levelIndex];
  const lower = project.levels[levelIndex - 1];
  const up = levelFaces(level);
  if (!up.outlines.length) return []; // étage sans contour fermé : la toiture du dessous s'en charge
  const low = levelFaces(lower);
  const out = [];
  low.outlines.forEach((gross, k) => {
    const diff = G.polygonDifference(gross, up.outlines);
    if (!diff.pieces.length) return;
    const net = low.innerOutlines[k] ? G.polygonDifference(low.innerOutlines[k], up.outlines) : diff;
    const area = diff.pieces.reduce((a, pc) => a + Math.abs(G.polygonArea(pc.outer))
      - pc.holes.reduce((b, h) => b + Math.abs(G.polygonArea(h)), 0), 0);
    out.push({ key: `terrace-${level.id}-${k}`, gross: diff.pieces, net: net.pieces, free: diff.free, facade: diff.facade, area });
  });
  return out;
}

const insidePiece = (p, pieces) => pieces.some((pc) => G.pointInPolygon(p, pc.outer) && !pc.holes.some((h) => G.pointInPolygon(p, h)));

export function balconyGeometry(b) {
  const n = G.norm(b.dir), t = G.perp(n);
  const base = [b.x, b.y];
  const w2 = b.width / 2;
  const poly = [
    G.add(base, G.mul(t, -w2)), G.add(base, G.mul(t, w2)),
    G.add(G.add(base, G.mul(t, w2)), G.mul(n, b.depth)), G.add(G.add(base, G.mul(t, -w2)), G.mul(n, b.depth)),
  ];
  return { poly, n, t, base };
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
  if (OPENING_TYPES[op.type]?.operation === 'sectional') {
    // porte de garage sectionnelle : panneaux horizontaux séparés par un joint
    const sections = Math.max(3, Math.round((h - f) / 0.5));
    const sh = (h - f) / sections;
    const panels = [];
    for (let i = 0; i < sections; i++) {
      panels.push(orientedBox(center, u, w - 2 * f, 0.045, z0 + i * sh + 0.006, z0 + (i + 1) * sh - 0.006));
    }
    return { frame: mergeMeshes(frame), panel: mergeMeshes(panels) };
  }
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
  if (!items.length || !body.roof?.enabled || bodyTopLevelIndex(project, body.id) !== project.levels.findIndex((l) => l.id === level.id)) return [];
  const z = levelElevation(project, level.id);
  const floorZ = z + (body.elevation || 0);
  const baseZ = floorZ + roofBaseHeight(project, level, body);
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

      const facePoly = face.poly.map((p) => [p[0], p[1]]);
      const preset = ROOF_OPENINGS[item.type] || ROOF_OPENINGS.skylight;
      const width = item.width ?? preset.width;
      const height = item.height ?? preset.height;
      const sill = item.sill ?? preset.sill;
      const invalid = (reason) => out.push({ item, preset, poly: null, ok: false, reason, body, floorZ });
      if (!Number.isFinite(width) || width <= 0.12) { invalid('largeur invalide'); continue; }
      const horiz = height / Math.sqrt(1 + slope * slope);

      if (preset.kind === 'dormer') {
        if (slope < 0.01) { invalid('une lucarne nécessite un pan incliné'); continue; }
        const pitch = item.pitch ?? preset.pitch;
        const setback = item.setback ?? preset.setback;
        if (![pitch, setback].every(Number.isFinite) || width <= 0.54 || pitch < 0 || pitch >= 85 || setback < 0
          || (preset.dormer === 'shed' && (!Number.isFinite(item.depth ?? preset.depth) || (item.depth ?? preset.depth) <= 0))) { invalid('dimensions de lucarne invalides'); continue; }
        // repère du pan : U vers le haut de la pente, V le long de l'égout
        const U = u, V = v;
        const us = facePoly.map((p) => G.dot(G.sub(p, anchor), U));
        const uMin = Math.min(...us);
        const uFront = uMin + setback;
        const origin = G.add(anchor, G.mul(U, uFront));
        const toWorld = (p) => G.add(G.add(origin, G.mul(U, p[0])), G.mul(V, p[1]));
        const zOrigin = zAt(origin);

        // Cotes mesurées depuis le plancher (comme une fenêtre de toit), converties dans le
        // repère de la lucarne, dont l'origine est posée sur le dessus de la couverture.
        const dz = zOrigin - floorZ;
        const legacy = item.ref !== 'floor';
        // projet antérieur : on garde la taille de la lucarne (égout), et la baie reprend
        // des valeurs courantes, puisque c'est précisément l'ancienne allège qui était fausse
        const eave = legacy ? (item.wallHeight ?? preset.wallHeight) + dz : (item.eave ?? preset.eave);
        const sillFloor = legacy ? preset.winSill : (item.winSill ?? preset.winSill);
        const winHeight = legacy ? preset.winHeight : (item.winHeight ?? preset.winHeight);
        if (![eave, sillFloor, winHeight].every(Number.isFinite) || sillFloor < 0 || winHeight <= 0.12 || eave - sillFloor <= 0.3) {
          invalid('dimensions de lucarne invalides'); continue;
        }
        const hWLocal = Math.max(0.8, eave - dz);
        // Façade de la lucarne à l'aplomb du mur (ou en avant) : la couverture et l'égout sont
        // interrompus devant elle, la baie peut descendre jusqu'à la jambette.
        // Lucarne en retrait dans la pente : la couverture passe devant, la baie doit la
        // dépasser d'au moins 15 cm (solin), sinon elle serait masquée.
        const overhang = body.roof?.overhang ?? 0.4;
        const flush = setback <= overhang + 0.05;
        const minSill = flush ? -tv + 0.05 : 0.15;
        const sillLocal = Math.max(minSill, sillFloor - dz);
        const d = G.buildDormer({
          type: preset.dormer,
          width,
          wallHeight: hWLocal,
          pitch,
          depth: item.depth ?? preset.depth,
          slope, baseDrop: tv,
          window: { height: winHeight, sill: sillLocal },
        });
        const floorValues = {
          eave: dz + hWLocal,
          winSill: dz + sillLocal,
          winHeight,
          windowHeight: d.window.height, // hauteur réellement logée dans la façade
          reduced: d.window.height < winHeight - 1e-3,
          raised: dz + sillLocal > sillFloor + 1e-3,
          flush,
        };
        // égout interrompu : le percement va jusqu'au bord du pan devant la lucarne
        const hole = flush
          ? d.hole.map(([hu, hv]) => [Math.abs(hu) < 1e-9 ? -setback + 1e-3 : hu, hv])
          : d.hole;
        const holeWorld = hole.map(toWorld);
        const ok2 = G.fitTranslation(holeWorld, facePoly, [0, 0], 0) !== null;
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
          reason: ok2 ? null : 'la lucarne dépasse le pan (rive ou faîtage)',
          ceilingFaces: d.ceilingFaces.map((f) => ({ poly: f.poly.map(toWorld), zAt: (p) => zOrigin + f.zAt([G.dot(G.sub(p, origin), U), G.dot(G.sub(p, origin), V)]) })),
          sillZ: floorZ + floorValues.winSill, floorZ, body, floorValues,
          hostKey: `roof-${body.id}-${k}-${face.part}`,
        });
        continue;
      }

      if (![height, sill].every(Number.isFinite) || height <= 0.12 || sill < 0) { invalid('dimensions de fenêtre invalides'); continue; }
      const rectAt = (t) => {
        const c = G.add(anchor, G.mul(u, t));
        return [
          G.add(G.add(c, G.mul(u, -horiz / 2)), G.mul(v, -width / 2)),
          G.add(G.add(c, G.mul(u, horiz / 2)), G.mul(v, -width / 2)),
          G.add(G.add(c, G.mul(u, horiz / 2)), G.mul(v, width / 2)),
          G.add(G.add(c, G.mul(u, -horiz / 2)), G.mul(v, width / 2)),
        ];
      };
      const want = slope > 1e-4 ? (floorZ + sill + tv + (slope * horiz) / 2 - zAt(anchor)) / slope : 0;
      const fitted = G.fitTranslation(rectAt(0), facePoly, u, want);
      const ok = fitted !== null;
      const t = fitted ?? want;
      const poly = rectAt(t);
      const clamped = ok && Math.abs(t - want) > 1e-3;
      out.push({
        item, preset, poly, u, v, zAt, tv, ok, clamped, reason: ok ? null : 'la fenêtre ne tient pas dans ce pan', outlineIndex: k, partIndex: face.part,
        sillZ: Math.min(...poly.map((p) => zAt(p))) - tv,
        floorZ, body,
        hostKey: `roof-${body.id}-${k}-${face.part}`,
      });
    }
  });
  for (const item of items) {
    if (!out.some((o) => o.item === item)) out.push({ item, poly: null, ok: false, reason: 'hors toiture', body, floorZ });
  }
  // Keep one result per item, and reject overlapping openings explicitly.
  const result = items.map((item) => out.find((o) => o.item === item && o.ok) || out.find((o) => o.item === item));
  const accepted = [];
  for (const o of result) {
    if (!o.ok) continue;
    if (accepted.some((a) => {
      const overlap = G.convexClip(o.poly, a.poly);
      return overlap && Math.abs(G.polygonArea(overlap)) > 1e-8;
    })) {
      o.ok = false;
      o.reason = 'chevauche une autre ouverture de toiture';
    } else accepted.push(o);
  }
  return result;
}

/**
 * Étage sous toiture : pour chaque corps couvert sur ce niveau, les dessous de pans
 * (plans) qui limitent murs intérieurs, pièces, plafond et équipements.
 */
export function atticContext(project, levelIndex) {
  const level = project.levels[levelIndex];
  const map = new Map();
  if (!isAttic(level)) return map;
  const z = levelElevation(project, level.id);
  const mainId = project.bodies[0].id;
  const ids = new Set(level.rooms.map((r) => r.bodyId || mainId));
  for (const id of ids) {
    const body = bodyById(project, id);
    if (!body.roof?.enabled || bodyTopLevelIndex(project, body.id) !== levelIndex) continue;
    const floorZ = z + (body.elevation || 0);
    const baseZ = floorZ + roofBaseHeight(project, level, body);
    const faces = [];
    let maxZ = baseZ;
    for (const outline of bodyOutlines(project, level, body.id, 1)) {
      const roof = G.buildRoof(outline, { ...body.roof, baseZ });
      const tv = roof.thicknessV || body.roof.thickness || 0.25;
      for (const f of roof.faces) {
        const zp = G.planeOf(f.poly);
        if (!zp) continue;
        faces.push({ poly: f.poly.map((q) => [q[0], q[1]]), zAt: (q) => zp(q) - tv });
        for (const q of f.poly) maxZ = Math.max(maxZ, q[2] - tv);
      }
    }
    faces.splice(0, faces.length, ...G.roofEnvelope(faces));
    const wallFaces = faces.slice();
    const openings = roofOpenings(project, level, body);
    for (const o of openings.filter((o) => o.ok && o.preset.kind === 'dormer')) {
      const remaining = faces.flatMap((f) => G.subtractConvexHoles(f.poly, [o.poly]).map((poly) => ({ poly, zAt: f.zAt })));
      faces.splice(0, faces.length, ...remaining, ...o.ceilingFaces);
      for (const f of o.ceilingFaces) for (const p of f.poly) maxZ = Math.max(maxZ, f.zAt(p));
    }
    const zUnder = (q) => G.roofHeightAt(faces, q);
    map.set(body.id, {
      body, faces, wallFaces, openings, floorZ, maxZ, zUnder,
      knee: level.attic.kneeWall ?? 0.9,
      ceilingZ: body.ceiling ? floorZ + (level.attic.ceilingHeight ?? 2.5) : null,
    });
  }
  return map;
}

// Escaliers d'un niveau, mis en plan et en volume (hauteurs depuis son plancher)
export function levelStairs(project, levelIndex) {
  const level = project.levels[levelIndex];
  const slabT = project.settings.slabThickness;
  return (level.stairs || []).map((st) => ({ stair: st, layout: stairLayout(st, level.height, slabT) }));
}

// Trémies percées dans le plancher d'un niveau par les escaliers de l'étage du dessous
export function levelTremies(project, levelIndex) {
  if (levelIndex <= 0) return [];
  return levelStairs(project, levelIndex - 1)
    .filter((s) => s.layout.tremie)
    .map((s) => ({ stair: s.stair, poly: s.layout.tremie, arrival: s.layout.arrival }));
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
    const attic = atticContext(project, li);
    const topOf = (body, category) => {
      const ctx = attic.get(body.id);
      if (ctx) return category === 'exterior' ? ctx.maxZ : Math.min(ctx.ceilingZ ?? Infinity, ctx.maxZ);
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

    // Planchers, un par corps et par contour fermé, percés des trémies d'escalier
    const tremies = levelTremies(project, li);
    for (const body of present) {
      const outlines = bodyOutlines(project, level, body.id, li === 0 ? 1 : -1);
      const zf = floorOf(body);
      outlines.forEach((outline, k) => {
        if (!outline || outline.length < 3) return;
        const holes = tremies.map((t) => t.poly).filter((t) => t.some((q) => G.pointInPolygon(q, outline)));
        const pieces = holes.length ? G.polygonDifference(outline, holes).pieces : [{ outer: outline, holes: [] }];
        if (!pieces.length) return;
        elements.push({
          kind: 'slab', level, levelIndex: li, body,
          name: `Plancher ${body.name} ${level.name}${outlines.length > 1 ? ` ${k + 1}` : ''}`,
          profile: outline, pieces, z0: zf - slabT, depth: slabT,
          mesh: mergeMeshes(pieces.map((pc) => extrudeWithHoles(pc.outer, pc.holes, zf - slabT, zf))),
          key: `slab-${level.id}-${body.id}-${k}`,
        });
      });
    }

    // Garde-corps autour des trémies, sur tous les bords sauf celui où l'on arrive
    tremies.forEach((t, i) => {
      const railParts = [];
      const c = G.polygonCentroid(t.poly);
      const m0 = G.mul(G.add(t.arrival[0], t.arrival[1]), 0.5);
      for (let k = 0; k < t.poly.length; k++) {
        const p = t.poly[k], q = t.poly[(k + 1) % t.poly.length];
        const m = G.mul(G.add(p, q), 0.5);
        if (G.projectOnSegment(m, t.arrival[0], t.arrival[1]).d < 1e-6 || G.dist(m, m0) < 1e-6) continue;
        const outward = G.norm(G.sub(m, c));
        let n = G.perp(G.norm(G.sub(q, p)));
        if (G.dot(n, outward) < 0) n = G.mul(n, -1);
        railParts.push(...railingParts(p, q, z, 1.0, 'bars', n));
      }
      elements.push({
        kind: 'tremieRail', level, levelIndex: li, body: bodyById(project, mainId), railParts,
        name: `Garde-corps de trémie ${level.name}${tremies.length > 1 ? ` ${i + 1}` : ''}`,
        key: `tremie-${level.id}-${t.stair.id}`,
      });
    });

    // Escaliers qui partent de ce niveau
    for (const { stair, layout } of levelStairs(project, li)) {
      elements.push({
        kind: 'stair', level, levelIndex: li, body: bodyById(project, mainId), stair, layout,
        name: `Escalier ${(STAIR_TYPES[stair.type] || STAIR_TYPES.straight).toLowerCase()}`,
        parts: layout.parts.map((p) => ({ ...p, mesh: { positions: p.mesh.positions.map(([x, y, zz]) => [x, y, z + zz]), triangles: p.mesh.triangles } })),
        key: `stair-${stair.id}`,
      });
    }

    // Pièces
    rooms.forEach(({ net, room, area }) => {
      if (!room || net.length < 3) return;
      const body = bodyOfRoom(room);
      const zf = floorOf(body);
      const ctx = attic.get(body.id);
      if (ctx) {
        // pièce sous les rampants : volume découpé, surface habitable à 1,80 m
        const top = ctx.ceilingZ ?? ctx.maxZ;
        elements.push({
          kind: 'space', level, levelIndex: li, name: room.name, room, area, body,
          areaHabitable: top < zf + 1.8 ? 0 : G.areaAtLeast(net, ctx.faces, zf + 1.8),
          profile: net, z0: zf, depth: top - zf,
          mesh: G.prismUnderRoof(net, zf, top, ctx.faces), tessellated: true,
          key: `space-${room.id}`,
        });
        return;
      }
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
      const actx = bodies.some((bd) => attic.has(bd.id));
      // A party wall follows the higher adjacent envelope, regardless of room order.
      const wallFaces = actx ? G.roofEnvelope(bodies.flatMap((bd) => {
        const ctx = attic.get(bd.id);
        if (!ctx) return [{ poly, zAt: () => topOf(bd, type.category) }];
        const faces = type.category === 'exterior' ? ctx.wallFaces : ctx.faces;
        return G.cellsUnderRoof(poly, base, topOf(bd, type.category), faces).map((c) => ({ poly: c.poly, zAt: c.top }));
      })) : null;
      const wallMesh = actx
        ? mergeMeshes(pieces.map((p) => G.prismUnderRoof(p.poly, base + p.z0, base + p.z1, wallFaces)))
        : mergeMeshes(pieces.map((p) => extrude(p.poly, base + p.z0, base + p.z1)));
      if (actx) {
        // une ouverture qui dépasse sous la pente est signalée
        const a0 = level.nodes[wall.a], b0 = level.nodes[wall.b];
        const u0 = G.norm(G.sub(b0, a0));
        for (const op of wall.openings || []) {
          const top = base + op.sill + op.height;
          const lim = Math.min(
            ...[-op.width / 2, op.width / 2].map((d) => G.roofHeightAt(wallFaces, G.add(a0, G.mul(u0, op.offset + d)))),

          );
          if (top > lim + 0.01) warnings.push(`${level.name} : ${OPENING_TYPES[op.type]?.label || 'Ouverture'} trop haute sous la pente (${Math.round((top - lim) * 100)} cm de trop).`);
        }
      }
      elements.push({
        kind: 'wall', level, levelIndex: li, wall, wallType: type, body: bodies[0], wallIds: group.ids,
        name: `${type.label} ${wall.id.slice(-4)}`,
        profile: poly, z0: base, depth: hw, tessellated: !!actx,
        mesh: wallMesh,
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
          voidProfile: { center, u, width: op.width, depth: wall.thickness + 0.02, z0: base + op.sill, height: op.height },
          key: `op-${op.id}`,
        });
      }
    }

    // Terrasses : dessus de l'étage inférieur que ce niveau ne couvre pas
    for (const tr of levelTerraces(project, li)) {
      const settings = level.terrace || { mode: 'terrace', railing: 'glass', railingHeight: 1.0 };
      const slabMesh = mergeMeshes(tr.net.map((pc) => extrudeWithHoles(pc.outer, pc.holes, z - slabT, z)));
      const railParts = [];
      if (settings.mode === 'terrace') {
        for (const [p, q] of tr.free) {
          const m = G.mul(G.add(p, q), 0.5);
          let inward = G.perp(G.norm(G.sub(q, p)));
          if (!insidePiece(G.add(m, G.mul(inward, 0.05)), tr.gross)) inward = G.mul(inward, -1);
          railParts.push(...railingParts(p, q, z, settings.railingHeight || 1.0, settings.railing || 'glass', inward));
        }
      }
      elements.push({
        kind: 'terrace', level, levelIndex: li, body: bodyById(project, mainId), mode: settings.mode,
        name: settings.mode === 'roof' ? `Toiture-terrasse ${level.name}` : `Terrasse ${level.name}`,
        pieces: tr.net, area: tr.area, slabMesh, railParts, z0: z - slabT, depth: slabT, top: z,
        key: tr.key,
      });
    }

    // Balcons en saillie : dalle en porte-à-faux, dessus au niveau du plancher
    for (const b of level.balconies || []) {
      const g = balconyGeometry(b);
      const th = b.thickness || BALCONY.thickness;
      const slabMesh = extrude(g.poly, z - th, z);
      const edges = [[g.poly[1], g.poly[2]], [g.poly[2], g.poly[3]], [g.poly[3], g.poly[0]]];
      const railParts = [];
      const centre = G.polygonCentroid(g.poly);
      for (const [p, q] of edges) {
        const m = G.mul(G.add(p, q), 0.5);
        const inward = G.norm(G.sub(centre, m));
        railParts.push(...railingParts(p, q, z, b.railingHeight || 1.0, b.railing || 'bars', inward));
      }
      elements.push({
        kind: 'balcony', level, levelIndex: li, body: bodyById(project, mainId), item: b,
        name: 'Balcon', pieces: [{ outer: g.poly, holes: [] }], area: b.width * b.depth,
        slabMesh, railParts, z0: z - th, depth: th, top: z,
        key: `balcony-${b.id}`,
      });
    }

    // Équipements : posés sur le sol du corps de bâtiment de la pièce qui les contient
    for (const item of level.equipment || []) {
      const cat = EQUIPMENT_TYPES[item.type];
      const roomInfo = rooms.find((r) => r.room && G.pointInPolygon([item.x, item.y], r.net)) || null;
      const body = roomInfo ? bodyOfRoom(roomInfo.room) : bodyById(project, mainId);
      const parts = placeEquipment(item, equipmentParts({ ...item, model: cat?.model }), floorOf(body));
      const ectx = attic.get(body.id);
      if (ectx) {
        const a = ((item.rotation || 0) * Math.PI) / 180;
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
          const lx = (sx * item.width) / 2, ly = (sy * item.depth) / 2;
          return [item.x + lx * Math.cos(a) - ly * Math.sin(a), item.y + lx * Math.sin(a) + ly * Math.cos(a)];
        });
        const lim = Math.min(...corners.map(ectx.zUnder), ectx.ceilingZ ?? Infinity);
        const top = floorOf(body) + (item.zOffset || 0) + item.height;
        if (top > lim + 0.01) warnings.push(`${level.name} : ${cat?.label || 'Équipement'} dépasse sous la pente (${Math.round((top - lim) * 100)} cm).`);
      }
      elements.push({
        kind: 'equipment', level, levelIndex: li, body, item, category: cat, room: roomInfo?.room || null,
        name: cat?.label || 'Équipement',
        parts,
        key: `equipment-${item.id}`,
      });
    }

    // Plafonds : sous la toiture, pour ne pas voir les rampants depuis l'intérieur
    for (const body of present) {
      if (!body.ceiling) continue;
      if (bodyTopLevelIndex(project, body.id) !== li) continue;
      const ep = body.ceilingThickness || 0.15;
      const cctx = attic.get(body.id);
      if (cctx) {
        // faux plafond horizontal, limité à la zone où les rampants sont plus hauts
        bodyOutlines(project, level, body.id, -1).forEach((outline, k) => {
          // pas de faux plafond sous une fenêtre de toit ni dans le volume d'une lucarne,
          // qui reste ouvert jusqu'à son propre toit (sinon le plafond le traverse)
          const holes = cctx.openings.filter((o) => o.ok && (o.preset.kind === 'skylight' || o.preset.kind === 'dormer')).map((o) => o.poly);
          const cells = G.subtractConvexHoles(outline, holes).flatMap((p) => G.cellsUnderRoof(p, cctx.ceilingZ, cctx.ceilingZ + ep, cctx.faces));
          if (!cells.length) return;
          elements.push({
            kind: 'ceiling', level, levelIndex: li, body,
            name: `Faux plafond ${body.name}${k ? ` ${k + 1}` : ''}`,
            profile: outline, z0: cctx.ceilingZ, depth: ep, tessellated: true,
            mesh: mergeMeshes(cells.map((c) => G.prismVarTop(c.poly, cctx.ceilingZ, c.top))),
            key: `ceil-${level.id}-${body.id}-${k}`,
          });
        });
        continue;
      }
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
      const baseZ = floorOf(body) + roofBaseHeight(project, level, body);
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
      for (const o of openings) {
        if (!o.ok) warnings.push(`${level.name} : ${o.preset?.label || 'Ouverture de toiture'} ${o.item.id} : ${o.reason}.`);
        else if (o.clamped) warnings.push(`${level.name} : fenêtre de toit ${o.item.id} recalée à ${(o.sillZ - o.floorZ).toFixed(2)} m d'allège.`);
      }
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
        (attic.has(body.id) ? [] : roof.panels).forEach((panel, i) => {
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
