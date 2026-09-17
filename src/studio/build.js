// Smelt Studio — transforme le modèle sémantique en éléments constructifs avec géométrie.
// Coordonnées : plan (x, y vers le bas) + z vertical, en mètres.
import * as G from './geometry.js';
import { WALL_TYPES, OPENING_TYPES } from './catalog.js';
import { levelElevation, wallHeight, levelFaces } from './model.js';

// ─── Triangulation (ear clipping, suffisant pour des polygones de plan) ────────

export function triangulate(poly) {
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
 * Construit la liste des éléments du bâtiment.
 * options.upToLevelIndex : limite l'affichage aux niveaux inférieurs ou égaux
 */
export function buildElements(project, options = {}) {
  const elements = [];
  const warnings = [];
  const levels = project.levels;
  const lastIndex = options.upToLevelIndex ?? levels.length - 1;
  const slabT = project.settings.slabThickness;

  levels.forEach((level, li) => {
    if (li > lastIndex) return;
    const z = levelElevation(project, level.id);
    const H = wallHeight(project, level);
    const polys = G.computeWallPolygons(level);
    const { rooms, outlines } = levelFaces(level);

    // Planchers : un par contour fermé
    outlines.forEach((outline, k) => {
      elements.push({
        kind: 'slab', level, levelIndex: li,
        name: outlines.length > 1 ? `Plancher ${level.name} ${k + 1}` : `Plancher ${level.name}`,
        profile: outline, z0: z - slabT, depth: slabT,
        mesh: extrude(outline, z - slabT, z),
        key: `slab-${level.id}-${k}`,
      });
    });

    // Pièces
    rooms.forEach(({ net, room, area }) => {
      if (!room || net.length < 3) return;
      elements.push({
        kind: 'space', level, levelIndex: li, name: room.name, room, area,
        profile: net, z0: z, depth: H,
        key: `space-${room.id}`,
      });
    });

    // Murs et ouvertures
    for (const wall of level.walls) {
      const poly = polys.get(wall.id);
      if (!poly || poly.length < 3) continue;
      const a = level.nodes[wall.a], b = level.nodes[wall.b];
      const u = G.norm(G.sub(b, a));
      const type = WALL_TYPES[wall.type] || { label: 'Mur', category: 'interior' };
      const pieces = G.wallPieces(level, wall, poly, H);
      elements.push({
        kind: 'wall', level, levelIndex: li, wall, wallType: type,
        name: `${type.label} ${wall.id.slice(-4)}`,
        profile: poly, z0: z, depth: H,
        mesh: mergeMeshes(pieces.map((p) => extrude(p.poly, z + p.z0, z + p.z1))),
        key: `wall-${wall.id}`,
      });
      for (const op of wall.openings || []) {
        const center = G.add(a, G.mul(u, op.offset));
        const { frame, panel } = openingMesh(op, center, u, wall.thickness, z);
        const cat = OPENING_TYPES[op.type];
        elements.push({
          kind: op.kind, level, levelIndex: li, wall, opening: op,
          name: `${cat?.label || (op.kind === 'door' ? 'Porte' : 'Fenêtre')} ${op.id.slice(-4)}`,
          center, u, z0: z + op.sill,
          frame, panel,
          voidProfile: { center, u, width: op.width, depth: wall.thickness + 0.02, z0: z + op.sill, height: Math.min(op.height, H - op.sill) },
          key: `op-${op.id}`,
        });
      }
    }
  });

  // Toiture sur le dernier niveau (si affiché)
  const top = levels[levels.length - 1];
  if (project.roof?.enabled && lastIndex >= levels.length - 1 && top) {
    const { outlines } = levelFaces(top);
    const baseZ = levelElevation(project, top.id) + top.height;
    outlines.forEach((outline, k) => {
      const roof = G.buildRoof(outline, { ...project.roof, baseZ });
      if (roof.warning) warnings.push(roof.warning);
      roof.parts.forEach((part, i) => {
        elements.push({
          kind: 'roof', level: top, levelIndex: levels.length - 1,
          name: part.name, mesh: G.orientShell({ positions: part.positions, triangles: part.triangles }),
          profile: part.profile, z0: part.z0, depth: part.depth,
          key: `roof-${k}-${i}`,
        });
      });
      roof.gables.forEach((g, i) => {
        const tri = g.points;
        const d = G.mul(g.axisDir, 0.15);
        const front = tri.map((p) => [p[0] + d[0], p[1] + d[1], p[2]]);
        const back = tri.map((p) => [p[0] - d[0], p[1] - d[1], p[2]]);
        const positions = [...front, ...back];
        const triangles = [[0, 1, 2], [3, 5, 4], [0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2], [2, 5, 3], [2, 3, 0]];
        elements.push({
          kind: 'gable', level: top, levelIndex: levels.length - 1,
          name: `Pignon ${i + 1}`, mesh: G.orientShell({ positions, triangles }),
          key: `gable-${k}-${i}`,
        });
      });
    });
  }
  return { elements, warnings };
}
