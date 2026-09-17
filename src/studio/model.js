// Smelt Studio — modèle de projet (source de vérité) et opérations d'édition.
import * as G from './geometry.js';
import { WALL_TYPES, DEFAULTS } from './catalog.js';

let idCounter = Date.now() % 100000;
export const uid = (p) => `${p}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function newProject(name = 'Nouveau projet') {
  return {
    format: 'smelt-studio',
    version: 1,
    uid: uid('P'),
    name,
    settings: { slabThickness: DEFAULTS.slabThickness },
    levels: [newLevel('Rez-de-chaussée')],
    roof: { enabled: true, type: 'gable', pitch: 35, overhang: 0.4, thickness: 0.25 },
    assets: {},
  };
}

export function newLevel(name, height = DEFAULTS.levelHeight) {
  return { id: uid('L'), name, height, nodes: {}, walls: [], rooms: [], plan: null };
}

export function levelElevation(project, levelId) {
  let z = 0;
  for (const l of project.levels) {
    if (l.id === levelId) return z;
    z += l.height;
  }
  return z;
}

export function wallHeight(project, level) {
  const isTop = project.levels[project.levels.length - 1].id === level.id;
  return isTop ? level.height : level.height - project.settings.slabThickness;
}

export function levelName(index) {
  if (index === 0) return 'Rez-de-chaussée';
  return `R+${index}`;
}

// ─── Store avec annuler / rétablir ────────────────────────────────────────────

const snapshot = (project) => {
  const { assets, ...rest } = project;
  return JSON.stringify(rest);
};

export class Store {
  constructor(project) {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.gesture = null;
    recomputeAll(this.project);
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(reason) { for (const fn of this.listeners) fn(reason); }

  load(project) {
    this.project = project;
    project.assets = project.assets || {};
    this.undoStack = [];
    this.redoStack = [];
    recomputeAll(project);
    this.emit('load');
  }

  commit(label, fn) {
    const before = snapshot(this.project);
    const result = fn(this.project);
    if (result === false) return false;
    recomputeAll(this.project);
    if (snapshot(this.project) !== before) {
      this.undoStack.push({ label, data: before });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.emit('change');
    return result;
  }

  // Gestes continus (glisser) : un seul pas d'annulation
  beginGesture(label) { this.gesture = { label, data: snapshot(this.project) }; }
  live(fn) { fn(this.project); recomputeAll(this.project); this.emit('live'); }
  endGesture() {
    if (!this.gesture) return;
    if (snapshot(this.project) !== this.gesture.data) {
      this.undoStack.push(this.gesture);
      this.redoStack = [];
    }
    this.gesture = null;
    this.emit('change');
  }
  cancelGesture() {
    if (!this.gesture) return;
    this.restore(this.gesture.data);
    this.gesture = null;
    this.emit('change');
  }

  restore(data) {
    const assets = this.project.assets;
    this.project = { ...JSON.parse(data), assets };
    recomputeAll(this.project);
  }
  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ label: step.label, data: snapshot(this.project) });
    this.restore(step.data);
    this.emit('change');
    return step.label;
  }
  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push({ label: step.label, data: snapshot(this.project) });
    this.restore(step.data);
    this.emit('change');
    return step.label;
  }
}

// ─── Calculs dérivés ──────────────────────────────────────────────────────────

export function recomputeAll(project) {
  for (const level of project.levels) recomputeRooms(level);
}

export function recomputeRooms(level) {
  const { rooms } = G.detectFaces(level);
  const previous = level.rooms || [];
  const used = new Set();
  const next = [];
  let counter = previous.length;
  for (const face of rooms) {
    let match = previous.find((r) => !used.has(r.id) && G.pointInPolygon([r.x, r.y], face.poly));
    if (!match) {
      const p = G.interiorPoint(face.poly);
      counter += 1;
      match = { id: uid('R'), name: `Pièce ${counter}`, x: p[0], y: p[1] };
    } else {
      used.add(match.id);
    }
    next.push(match);
  }
  level.rooms = next;
}

export function levelFaces(level) {
  const faces = G.detectFaces(level);
  const rooms = faces.rooms.map((face) => {
    const room = level.rooms.find((r) => G.pointInPolygon([r.x, r.y], face.poly));
    const net = G.roomNetPolygon(face);
    return { face, room, net, area: Math.abs(G.polygonArea(net)) };
  });
  const outlines = faces.outers.map((f) => G.outerGrossPolygon(f));
  return { rooms, outlines };
}

// ─── Opérations sur les murs ──────────────────────────────────────────────────

const TOL = 1e-3;

function wallLength(level, w) {
  return G.dist(level.nodes[w.a], level.nodes[w.b]);
}

export function findNodeAt(level, p, tol = TOL) {
  for (const [id, q] of Object.entries(level.nodes)) if (G.dist(p, q) <= tol) return id;
  return null;
}

function splitWall(level, wall, p) {
  const a = level.nodes[wall.a], b = level.nodes[wall.b];
  const L = G.dist(a, b);
  const pr = G.projectOnSegment(p, a, b);
  const cut = pr.t * L;
  const nid = uid('n');
  level.nodes[nid] = pr.point;
  const w2 = { ...wall, id: uid('w'), a: nid, b: wall.b, openings: [] };
  const keep = [];
  for (const o of wall.openings || []) {
    if (o.offset <= cut) keep.push(o);
    else w2.openings.push({ ...o, offset: o.offset - cut });
  }
  wall.b = nid;
  wall.openings = keep;
  level.walls.splice(level.walls.indexOf(wall) + 1, 0, w2);
  return nid;
}

// Retourne l'id d'un nœud au point p (réutilise un nœud, coupe un mur si besoin)
export function nodeAt(level, p) {
  const existing = findNodeAt(level, p);
  if (existing) return existing;
  for (const w of level.walls) {
    const a = level.nodes[w.a], b = level.nodes[w.b];
    const pr = G.projectOnSegment(p, a, b);
    if (pr.d <= TOL && pr.t > 1e-4 && pr.t < 1 - 1e-4) return splitWall(level, w, p);
  }
  const id = uid('n');
  level.nodes[id] = [p[0], p[1]];
  return id;
}

function wallBetween(level, n1, n2) {
  return level.walls.find((w) => (w.a === n1 && w.b === n2) || (w.a === n2 && w.b === n1));
}

/** Ajoute un mur de p1 à p2 en gardant le graphe planaire (coupe aux croisements). */
export function addWall(level, p1, p2, props) {
  if (G.dist(p1, p2) < 0.02) return [];
  const crossings = [];
  for (const w of level.walls) {
    const a = level.nodes[w.a], b = level.nodes[w.b];
    const hit = G.segmentIntersection(p1, p2, a, b);
    if (hit && hit.t > 1e-4 && hit.t < 1 - 1e-4 && hit.u > -1e-6 && hit.u < 1 + 1e-6) crossings.push(hit);
  }
  crossings.sort((m, n) => m.t - n.t);
  const pts = [p1, ...crossings.map((c) => c.point), p2];
  const ids = pts.map((p) => nodeAt(level, p));
  const created = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    if (ids[i] === ids[i + 1] || wallBetween(level, ids[i], ids[i + 1])) continue;
    const w = {
      id: uid('w'),
      a: ids[i],
      b: ids[i + 1],
      type: props.type,
      thickness: props.thickness ?? WALL_TYPES[props.type]?.thickness ?? 0.2,
      openings: [],
    };
    level.walls.push(w);
    created.push(w);
  }
  return created;
}

function removeOrphanNodes(level) {
  const used = new Set();
  for (const w of level.walls) { used.add(w.a); used.add(w.b); }
  for (const id of Object.keys(level.nodes)) if (!used.has(id)) delete level.nodes[id];
}

// Fusionne deux murs alignés de même type autour d'un nœud de degré 2
function mergeCollinearAt(level, nodeId) {
  const ws = level.walls.filter((w) => w.a === nodeId || w.b === nodeId);
  if (ws.length !== 2) return;
  const [w1, w2] = ws;
  if (w1.type !== w2.type || Math.abs(w1.thickness - w2.thickness) > 1e-6) return;
  const o1 = w1.a === nodeId ? w1.b : w1.a;
  const o2 = w2.a === nodeId ? w2.b : w2.a;
  const P = level.nodes[nodeId], A = level.nodes[o1], B = level.nodes[o2];
  if (Math.abs(G.cross(G.norm(G.sub(P, A)), G.norm(G.sub(B, P)))) > 1e-4) return;
  if (G.dot(G.sub(P, A), G.sub(B, P)) <= 0) return;
  // nouveau mur o1 → o2
  const L1 = G.dist(A, P);
  const openings = [];
  for (const o of w1.openings || []) openings.push({ ...o, offset: w1.a === o1 ? o.offset : L1 - o.offset });
  const L2 = G.dist(P, B);
  for (const o of w2.openings || []) openings.push({ ...o, offset: L1 + (w2.a === nodeId ? o.offset : L2 - o.offset) });
  const merged = { ...w1, id: w1.id, a: o1, b: o2, openings };
  level.walls = level.walls.filter((w) => w !== w1 && w !== w2);
  level.walls.push(merged);
  delete level.nodes[nodeId];
}

export function deleteWall(level, wallId) {
  const w = level.walls.find((x) => x.id === wallId);
  if (!w) return;
  level.walls = level.walls.filter((x) => x !== w);
  removeOrphanNodes(level);
  for (const n of [w.a, w.b]) if (level.nodes[n]) mergeCollinearAt(level, n);
}

export function deleteNode(level, nodeId) {
  const neighbours = new Set();
  for (const w of level.walls) {
    if (w.a === nodeId) neighbours.add(w.b);
    if (w.b === nodeId) neighbours.add(w.a);
  }
  level.walls = level.walls.filter((w) => w.a !== nodeId && w.b !== nodeId);
  delete level.nodes[nodeId];
  removeOrphanNodes(level);
  for (const n of neighbours) if (level.nodes[n]) mergeCollinearAt(level, n);
}

export function moveNode(level, nodeId, p) {
  level.nodes[nodeId] = [p[0], p[1]];
  clampOpenings(level);
}

// Après un déplacement : si le nœud tombe sur un autre nœud, on fusionne
export function settleNode(level, nodeId) {
  const p = level.nodes[nodeId];
  const other = Object.entries(level.nodes).find(([id, q]) => id !== nodeId && G.dist(p, q) < 0.01);
  if (!other) return;
  const target = other[0];
  for (const w of level.walls) {
    if (w.a === nodeId) w.a = target;
    if (w.b === nodeId) w.b = target;
  }
  delete level.nodes[nodeId];
  const seen = new Set();
  level.walls = level.walls.filter((w) => {
    if (w.a === w.b) return false;
    const key = [w.a, w.b].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  removeOrphanNodes(level);
}

export function clampOpenings(level) {
  for (const w of level.walls) {
    const L = wallLength(level, w);
    for (const o of w.openings || []) {
      o.width = Math.min(o.width, Math.max(0.2, L - 0.1));
      o.offset = Math.max(o.width / 2 + 0.05, Math.min(L - o.width / 2 - 0.05, o.offset));
    }
  }
}

// ─── Niveaux ──────────────────────────────────────────────────────────────────

export function duplicateLevelData(source, what) {
  const lvl = newLevel('', source.height);
  const map = {};
  const keepWall = (w) => (WALL_TYPES[w.type]?.category === 'partition' ? what.partitions : what.walls);
  const walls = source.walls.filter(keepWall);
  for (const w of walls) {
    for (const n of [w.a, w.b]) {
      if (!map[n]) { map[n] = uid('n'); lvl.nodes[map[n]] = source.nodes[n].slice(); }
    }
    lvl.walls.push({
      ...w,
      id: uid('w'),
      a: map[w.a],
      b: map[w.b],
      openings: what.openings ? (w.openings || []).map((o) => ({ ...o, id: uid('o') })) : [],
    });
  }
  if (what.rooms) lvl.rooms = source.rooms.map((r) => ({ ...r, id: uid('R') }));
  // fusion des murs devenus alignés (si on n'a pas copié les cloisons)
  for (const id of Object.keys(lvl.nodes)) if (lvl.nodes[id]) mergeCollinearAt(lvl, id);
  return lvl;
}

// ─── Plans de référence ───────────────────────────────────────────────────────

// Transforme un point image (px) en point plan (m)
export function planImageToWorld(plan, px) {
  const s = plan.scale;
  const r = ((plan.rotation || 0) * Math.PI) / 180;
  const x = px[0] * s, y = px[1] * s;
  return [plan.x + x * Math.cos(r) - y * Math.sin(r), plan.y + x * Math.sin(r) + y * Math.cos(r)];
}

export function planWorldToImage(plan, p) {
  const r = ((plan.rotation || 0) * Math.PI) / 180;
  const dx = p[0] - plan.x, dy = p[1] - plan.y;
  const x = dx * Math.cos(r) + dy * Math.sin(r);
  const y = -dx * Math.sin(r) + dy * Math.cos(r);
  return [x / plan.scale, y / plan.scale];
}

// Recale l'échelle en gardant le point « anchor » (monde) fixe
export function rescalePlan(plan, factor, anchor) {
  const img = planWorldToImage(plan, anchor);
  plan.scale *= factor;
  const moved = planImageToWorld(plan, img);
  plan.x += anchor[0] - moved[0];
  plan.y += anchor[1] - moved[1];
}

export function rotatePlan(plan, deltaDeg, pivot) {
  const img = planWorldToImage(plan, pivot);
  plan.rotation = (((plan.rotation || 0) + deltaDeg) % 360 + 360) % 360;
  const moved = planImageToWorld(plan, img);
  plan.x += pivot[0] - moved[0];
  plan.y += pivot[1] - moved[1];
}

// ─── Sérialisation ────────────────────────────────────────────────────────────

export function validateProject(data) {
  if (!data || data.format !== 'smelt-studio' || !Array.isArray(data.levels)) {
    throw new Error("Ce fichier n'est pas un projet Smelt Studio (.smelt.json).");
  }
  data.assets = data.assets || {};
  data.uid = data.uid || uid('P');
  data.settings = { slabThickness: DEFAULTS.slabThickness, ...(data.settings || {}) };
  data.roof = { enabled: true, type: 'gable', pitch: 35, overhang: 0.4, thickness: 0.25, ...(data.roof || {}) };
  for (const l of data.levels) {
    l.nodes = l.nodes || {};
    l.walls = l.walls || [];
    l.rooms = l.rooms || [];
    for (const w of l.walls) w.openings = w.openings || [];
  }
  return data;
}
