// Smelt Studio — éditeur de plan 2D (canvas).
import * as G from './geometry.js';
import * as M from './model.js';
import { WALL_TYPES, OPENING_TYPES, DEFAULTS } from './catalog.js';
import { loadImage } from './io.js';
import { roofOpenings } from './build.js';
import { SKYLIGHT, ROOF_OPENINGS } from './catalog.js';

const INK = '#1f2a30';
const INK_SOFT = '#5b676e';
const ACCENT = '#e8672a';
const ROOM_FILL = 'rgba(62, 142, 128, 0.10)';
const ROOM_FILL_SEL = 'rgba(232, 103, 42, 0.14)';
const ROOM_INK = '#2c5d55';
const WALL_FILL = { exterior: '#26323a', interior: '#4a565d', partition: '#8a959b' };
// teintes des corps de bâtiment (le premier garde le vert d'origine)
const BODY_TINTS = [
  { fill: 'rgba(62,142,128,0.10)', hover: 'rgba(62,142,128,0.17)', ink: '#2c5d55' },
  { fill: 'rgba(86,118,178,0.12)', hover: 'rgba(86,118,178,0.19)', ink: '#3a5590' },
  { fill: 'rgba(176,128,58,0.13)', hover: 'rgba(176,128,58,0.20)', ink: '#8a5f1d' },
  { fill: 'rgba(140,96,160,0.13)', hover: 'rgba(140,96,160,0.20)', ink: '#6b4680' },
];

const fmtLen = (m) => `${m.toFixed(2).replace('.', ',')} m`;
const fmtArea = (a) => `${a.toFixed(1).replace('.', ',')} m²`;

export class Editor2D {
  constructor(canvas, store, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.hooks = hooks; // { onSelect, onStatus, onToast, requestScaleDistance, onToolChange }
    this.levelId = store.project.levels[0].id;
    this.view = { cx: 5, cy: 4, zoom: 50 };
    this.tool = 'select';
    this.wallType = 'ext30';
    this.traceMode = 'axis'; // axis | edge
    this.edgeSide = 1;
    this.openingType = 'door';
    this.roofOpeningType = 'skylight';
    this.selection = null;
    this.hover = null;
    this.mouse = null;
    this.state = {};
    this.images = new Map();
    this.keys = { shift: false, space: false };
    this.typed = null;
    this.needsFit = true;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement);
    this.resize();
    this.bindEvents();
    this.loop();
  }

  // ─── Accès ─────────────────────────────────────────────────────────────────
  get project() { return this.store.project; }
  get level() {
    const l = this.project.levels.find((x) => x.id === this.levelId);
    if (!l) { this.levelId = this.project.levels[0].id; return this.project.levels[0]; }
    return l;
  }
  get levelIndex() { return this.project.levels.findIndex((l) => l.id === this.levelId); }
  get levelBelow() { const i = this.levelIndex; return i > 0 ? this.project.levels[i - 1] : null; }

  setLevel(id) {
    this.levelId = id;
    this.cancelTool();
    this.select(null);
    this.invalidate();
  }

  invalidate() { this.dirty = true; }

  resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.w = parent.clientWidth;
    this.h = parent.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.w * dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * dpr));
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.dpr = dpr;
    if (this.needsFit && this.w > 0) this.fit();
    this.invalidate();
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
  }

  // ─── Repères ───────────────────────────────────────────────────────────────
  toScreen(p) {
    return [(p[0] - this.view.cx) * this.view.zoom + this.w / 2, (p[1] - this.view.cy) * this.view.zoom + this.h / 2];
  }
  toWorld(s) {
    return [(s[0] - this.w / 2) / this.view.zoom + this.view.cx, (s[1] - this.h / 2) / this.view.zoom + this.view.cy];
  }
  px(n) { return n / this.view.zoom; }

  fit() {
    const pts = [];
    const L = this.level;
    for (const p of Object.values(L.nodes)) pts.push(p);
    if (L.plan) {
      const img = this.imageFor(L.plan);
      if (!img) { this.needsFit = true; return; }
      {
        for (const c of [[0, 0], [img.naturalWidth, 0], [0, img.naturalHeight], [img.naturalWidth, img.naturalHeight]]) {
          pts.push(M.planImageToWorld(L.plan, c));
        }
      }
    }
    if (!pts.length) { this.view = { cx: 5, cy: 4, zoom: Math.max(20, Math.min(this.w, this.h) / 14) }; this.needsFit = false; return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const wv = Math.max(x1 - x0, 2), hv = Math.max(y1 - y0, 2);
    this.view.cx = (x0 + x1) / 2;
    this.view.cy = (y0 + y1) / 2;
    this.view.zoom = Math.min((this.w - 80) / wv, (this.h - 80) / hv);
    this.needsFit = false;
    this.invalidate();
  }

  zoomAt(screen, factor) {
    const before = this.toWorld(screen);
    this.view.zoom = Math.max(2, Math.min(2000, this.view.zoom * factor));
    const after = this.toWorld(screen);
    this.view.cx += before[0] - after[0];
    this.view.cy += before[1] - after[1];
    this.invalidate();
  }

  // ─── Images de plan ────────────────────────────────────────────────────────
  imageFor(plan) {
    if (!plan) return null;
    const cached = this.images.get(plan.assetId);
    if (cached) return cached.complete ? cached : null;
    const src = this.project.assets[plan.assetId];
    if (!src) return null;
    const img = new Image();
    img.onload = () => { if (this.needsFit) this.fit(); this.invalidate(); };
    img.src = src;
    this.images.set(plan.assetId, img);
    return null;
  }

  // ─── Outils ────────────────────────────────────────────────────────────────
  setTool(tool, opts = {}) {
    this.cancelTool();
    if (tool === 'wall' && this.level.plan && !this.level.plan.calibrated) {
      this.hooks.onToast("Réglez d'abord l'échelle du plan (étape 2).", 'warn');
      tool = 'scale';
    }
    this.tool = tool;
    Object.assign(this, opts);
    this.state = {};
    this.canvas.dataset.tool = tool;
    this.hooks.onToolChange?.(tool);
    this.updateStatus();
    this.invalidate();
  }

  cancelTool() {
    if (this.tool === 'wall' && this.traceMode === 'edge' && this.state.points?.length > 1) this.commitEdgeChain(false);
    this.state = {};
    this.typed = null;
    this.hooks.onTyped?.(null);
    if (this.store.gesture) this.store.cancelGesture();
    this.invalidate();
  }

  select(sel) {
    this.selection = sel;
    this.hooks.onSelect?.(sel);
    this.invalidate();
  }

  // ─── Aimantation ───────────────────────────────────────────────────────────
  snapPoint(raw, { from = null, excludeNode = null, freeAngle = false } = {}) {
    const L = this.level;
    const tolNode = this.px(10), tolWall = this.px(8), tolAlign = this.px(7);
    const nodes = Object.entries(L.nodes).filter(([id]) => id !== excludeNode);
    const guides = [];
    const grid = DEFAULTS.gridStep;

    // 1. nœud existant
    let best = null;
    for (const [id, p] of nodes) {
      const d = G.dist(raw, p);
      if (d < tolNode && (!best || d < best.d)) best = { d, point: p.slice(), label: 'Angle', nodeId: id };
    }
    if (best) return { ...best, guides };

    // nœuds du niveau inférieur (utile pour caler un étage)
    const below = this.levelBelow;

    if (from) {
      const v = G.sub(raw, from);
      let dir = G.norm(v);
      let L0 = G.len(v);
      if (!freeAngle) {
        const ang = Math.atan2(v[1], v[0]);
        const step = Math.PI / 4;
        const a = Math.round(ang / step) * step;
        dir = [Math.cos(a), Math.sin(a)];
        L0 = G.dot(v, dir);
      }
      // mur existant coupé par la direction
      let cand = null;
      for (const w of L.walls) {
        const a = L.nodes[w.a], b = L.nodes[w.b];
        const hit = G.segmentIntersection(from, G.add(from, dir), a, b);
        if (!hit || hit.u < -1e-6 || hit.u > 1 + 1e-6 || hit.t < 0.05) continue;
        if (Math.abs(hit.t - L0) < tolWall && (!cand || Math.abs(hit.t - L0) < Math.abs(cand.t - L0))) cand = { t: hit.t, label: 'Sur le mur' };
      }
      // alignement avec un nœud (x ou y)
      if (!cand) {
        for (const [, p] of nodes) {
          for (const axis of [0, 1]) {
            if (Math.abs(dir[axis]) < 1e-6) continue;
            const t = (p[axis] - from[axis]) / dir[axis];
            if (t > 0.05 && Math.abs(t - L0) < tolAlign) {
              if (!cand || Math.abs(t - L0) < Math.abs(cand.t - L0)) cand = { t, label: 'Alignement', guide: [p, G.add(from, G.mul(dir, t))] };
            }
          }
        }
      }
      if (!cand && below) {
        for (const p of Object.values(below.nodes)) {
          const pr = G.dot(G.sub(p, from), dir);
          const off = G.dist(G.add(from, G.mul(dir, pr)), p);
          if (off < tolNode && Math.abs(pr - L0) < tolNode) cand = { t: pr, label: 'Étage inférieur' };
        }
      }
      if (cand) {
        if (cand.guide) guides.push(cand.guide);
        return { point: G.add(from, G.mul(dir, cand.t)), label: cand.label, guides, length: cand.t, dir };
      }
      const t = Math.max(0, Math.round(L0 / grid) * grid);
      return { point: G.add(from, G.mul(dir, t)), label: freeAngle ? 'Libre' : 'Angle 45°', guides, length: t, dir };
    }

    // 2. sur un mur
    for (const w of L.walls) {
      const pr = G.projectOnSegment(raw, L.nodes[w.a], L.nodes[w.b]);
      if (pr.d < tolWall && (!best || pr.d < best.d)) best = { d: pr.d, point: pr.point, label: 'Sur le mur' };
    }
    if (best) {
      // arrondi le long du mur
      return { ...best, guides };
    }
    // 3. étage inférieur
    if (below) {
      for (const p of Object.values(below.nodes)) {
        if (G.dist(raw, p) < tolNode) return { point: p.slice(), label: 'Étage inférieur', guides };
      }
    }
    // 4. alignements puis grille
    let x = Math.round(raw[0] / grid) * grid, y = Math.round(raw[1] / grid) * grid;
    let label = 'Grille';
    let ax = null, ay = null;
    for (const [, p] of nodes) {
      if (Math.abs(raw[0] - p[0]) < tolAlign && (!ax || Math.abs(raw[0] - p[0]) < Math.abs(raw[0] - ax[0]))) ax = p;
      if (Math.abs(raw[1] - p[1]) < tolAlign && (!ay || Math.abs(raw[1] - p[1]) < Math.abs(raw[1] - ay[1]))) ay = p;
    }
    if (ax) { x = ax[0]; label = 'Alignement'; }
    if (ay) { y = ay[1]; label = 'Alignement'; }
    if (ax) guides.push([ax, [x, y]]);
    if (ay) guides.push([ay, [x, y]]);
    return { point: [x, y], label, guides };
  }

  // ─── Événements ────────────────────────────────────────────────────────────
  bindEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const s = this.eventScreen(e);
      this.zoomAt(s, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('dblclick', (e) => this.onDouble(e));
    c.addEventListener('pointerleave', () => { this.mouse = null; this.invalidate(); });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
  }

  eventScreen(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  onDown(e) {
    const s = this.eventScreen(e);
    const w = this.toWorld(s);
    this.canvas.setPointerCapture(e.pointerId);
    this.keys.shift = e.shiftKey;
    if (e.button === 1 || e.button === 2 || this.keys.space) {
      if (e.button === 2 && this.tool === 'wall' && this.state.points?.length) { this.finishWall(); return; }
      this.pan = { start: s, cx: this.view.cx, cy: this.view.cy };
      return;
    }
    if (e.button !== 0) return;
    const handler = {
      select: () => this.selectDown(w, s),
      wall: () => this.wallClick(w),
      opening: () => this.openingClick(w),
      scale: () => this.scaleClick(w),
      measure: () => this.measureClick(w),
      calage: () => this.calageClick(w),
      align2: () => this.align2Click(w),
      skylight: () => this.skylightClick(w),
      movePlan: () => { if (this.level.plan) { this.store.beginGesture('Déplacer le plan'); this.drag = { kind: 'plan', start: w, x: this.level.plan.x, y: this.level.plan.y }; } },
    }[this.tool];
    try {
      handler?.();
    } catch (err) {
      console.error(err);
      this.hooks.onToast(`L'outil a rencontré une erreur : ${err.message}`, 'warn');
    }
  }

  onMove(e) {
    const s = this.eventScreen(e);
    const w = this.toWorld(s);
    this.mouse = { s, w };
    this.keys.shift = e.shiftKey;
    if (this.pan) {
      this.view.cx = this.pan.cx - (s[0] - this.pan.start[0]) / this.view.zoom;
      this.view.cy = this.pan.cy - (s[1] - this.pan.start[1]) / this.view.zoom;
      this.invalidate();
      return;
    }
    if (this.drag) this.dragMove(w, s);
    else if (this.tool === 'select') this.hover = this.hitTest(w);
    else if (this.tool === 'opening') this.hover = this.openingPreview(w);
    else if (this.tool === 'skylight') this.hover = this.skylightPreview(w);
    this.updateStatus();
    this.invalidate();
  }

  onUp() {
    if (this.pan) {
      this.pan = null;
      if (this.drag?.kind === 'pending') this.drag = null;
      return;
    }
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      if (d.kind === 'pending') {
        // simple clic sur le vide
        this.select(null);
        return;
      }
      if (d.kind === 'node') this.store.live((p) => M.settleNode(this.level, d.id));
      if (d.moved) this.store.endGesture();
      else this.store.cancelGesture();
    }
  }

  onDouble() {
    if (this.tool === 'wall') this.finishWall();
  }

  onKey(e, down) {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Shift') { this.keys.shift = down; this.invalidate(); }
    if (e.code === 'Space') { this.keys.space = down; if (down) e.preventDefault(); }
    if (!down) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) return; // géré par l'application
    // saisie d'une longueur pendant le tracé
    if (this.tool === 'wall' && this.state.points?.length) {
      if (/^[0-9]$/.test(e.key) || e.key === '.' || e.key === ',') {
        this.typed = (this.typed || '') + (e.key === ',' ? '.' : e.key);
        this.hooks.onTyped?.(this.typed);
        e.preventDefault();
        return;
      }
      if (e.key === 'Backspace' && this.typed) {
        this.typed = this.typed.slice(0, -1) || null;
        this.hooks.onTyped?.(this.typed);
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && this.typed) {
        this.applyTypedLength();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') { this.finishWall(); return; }
    }
    if (e.key === 'Escape') {
      if (this.typed) { this.typed = null; this.hooks.onTyped?.(null); return; }
      if (this.tool === 'wall' && this.state.points?.length) { this.finishWall(); return; }
      if (this.tool !== 'select') { this.hooks.requestTool?.('select'); return; }
      this.select(null);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection) { this.deleteSelection(); e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if (k === 'f' && this.tool === 'wall') { this.edgeSide *= -1; this.invalidate(); this.hooks.onToast('Côté du mur inversé'); return; }
    if (k === 'v') this.hooks.requestTool?.('select');
    if (k === 'm') this.hooks.requestTool?.('wall');
    if (k === 'o') this.hooks.requestTool?.('opening');
    if (k === 'c') this.fit();
  }

  // ─── Sélection et glisser ──────────────────────────────────────────────────
  hitTest(w) {
    const L = this.level;
    const tol = this.px(8);
    for (const o of this.roofItems()) {
      if (o.poly && G.pointInPolygon(w, o.poly)) return { type: 'roofitem', id: o.item.id, bodyId: o.body.id };
    }
    // ouvertures
    for (const wall of L.walls) {
      const a = L.nodes[wall.a], b = L.nodes[wall.b];
      const u = G.norm(G.sub(b, a));
      for (const o of wall.openings) {
        const rel = G.sub(w, a);
        const along = G.dot(rel, u), across = Math.abs(G.cross(u, rel));
        if (Math.abs(along - o.offset) <= o.width / 2 && across <= wall.thickness / 2 + tol) {
          return { type: 'opening', id: o.id, wallId: wall.id };
        }
      }
    }
    for (const [id, p] of Object.entries(L.nodes)) {
      if (G.dist(w, p) < this.px(9)) return { type: 'node', id };
    }
    for (const wall of L.walls) {
      const pr = G.projectOnSegment(w, L.nodes[wall.a], L.nodes[wall.b]);
      if (pr.d <= wall.thickness / 2 + this.px(3)) return { type: 'wall', id: wall.id };
    }
    const { rooms } = M.levelFaces(L);
    for (const r of rooms) {
      if (r.room && G.pointInPolygon(w, r.face.poly)) return { type: 'room', id: r.room.id };
    }
    return null;
  }

  selectDown(w, s) {
    const hit = this.hitTest(w);
    if (!hit) {
      this.drag = { kind: 'pending' };
      this.pan = { start: s, cx: this.view.cx, cy: this.view.cy };
      this.select(null);
      return;
    }
    this.select(hit);
    const L = this.level;
    if (hit.type === 'node') {
      this.store.beginGesture('Déplacer un angle');
      this.drag = { kind: 'node', id: hit.id, start: w };
    } else if (hit.type === 'wall') {
      const wall = L.walls.find((x) => x.id === hit.id);
      this.store.beginGesture('Déplacer un mur');
      this.drag = { kind: 'wall', id: hit.id, start: w, a: L.nodes[wall.a].slice(), b: L.nodes[wall.b].slice(), wa: wall.a, wb: wall.b };
    } else if (hit.type === 'opening') {
      const wall = L.walls.find((x) => x.id === hit.wallId);
      const o = wall.openings.find((x) => x.id === hit.id);
      this.store.beginGesture('Déplacer une ouverture');
      this.drag = { kind: 'opening', wallId: wall.id, id: o.id, start: w, offset: o.offset };
    }
  }

  dragMove(w) {
    const d = this.drag;
    const L = this.level;
    if (d.kind === 'pending') return;
    if (d.kind === 'plan') {
      d.moved = true;
      this.store.live(() => {
        const p = this.level.plan;
        p.x = d.x + (w[0] - d.start[0]);
        p.y = d.y + (w[1] - d.start[1]);
      });
      return;
    }
    if (G.dist(w, d.start) < this.px(3) && !d.moved) return;
    d.moved = true;
    if (d.kind === 'node') {
      const snap = this.snapPoint(w, { excludeNode: d.id });
      // alignement avec les voisins
      const neighbours = L.walls.filter((x) => x.a === d.id || x.b === d.id).map((x) => L.nodes[x.a === d.id ? x.b : x.a]);
      let p = snap.point;
      if (snap.label === 'Grille' && !this.keys.shift) {
        for (const q of neighbours) {
          if (Math.abs(p[0] - q[0]) < this.px(10)) p = [q[0], p[1]];
          if (Math.abs(p[1] - q[1]) < this.px(10)) p = [p[0], q[1]];
        }
      }
      this.snapInfo = snap;
      this.store.live(() => M.moveNode(this.level, d.id, p));
    } else if (d.kind === 'wall') {
      const u = G.norm(G.sub(d.b, d.a));
      const n = G.perp(u);
      const grid = DEFAULTS.gridStep;
      const off = Math.round(G.dot(G.sub(w, d.start), n) / grid) * grid;
      this.store.live(() => {
        const lv = this.level;
        lv.nodes[d.wa] = G.add(d.a, G.mul(n, off));
        lv.nodes[d.wb] = G.add(d.b, G.mul(n, off));
        M.clampOpenings(lv);
      });
    } else if (d.kind === 'opening') {
      const wall = L.walls.find((x) => x.id === d.wallId);
      if (!wall) return;
      const a = L.nodes[wall.a], b = L.nodes[wall.b];
      const u = G.norm(G.sub(b, a));
      const grid = DEFAULTS.gridStep;
      const delta = Math.round(G.dot(G.sub(w, d.start), u) / grid) * grid;
      this.store.live(() => {
        const wl = this.level.walls.find((x) => x.id === d.wallId);
        const o = wl.openings.find((x) => x.id === d.id);
        o.offset = d.offset + delta;
        M.clampOpenings(this.level);
      });
    }
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    const labels = { wall: 'Mur supprimé', node: 'Angle supprimé', opening: 'Ouverture supprimée', roofitem: 'Fenêtre de toit supprimée', room: '' };
    if (sel.type === 'room') { this.hooks.onToast('Une pièce disparaît quand on supprime un de ses murs.'); return; }
    this.store.commit(labels[sel.type], () => {
      const L = this.level;
      if (sel.type === 'wall') M.deleteWall(L, sel.id);
      if (sel.type === 'node') M.deleteNode(L, sel.id);
      if (sel.type === 'opening') {
        const wall = L.walls.find((x) => x.id === sel.wallId);
        if (wall) wall.openings = wall.openings.filter((o) => o.id !== sel.id);
      }
      if (sel.type === 'roofitem') {
        const body = this.project.bodies.find((b) => b.id === sel.bodyId);
        if (body) body.roofItems = body.roofItems.filter((it) => it.id !== sel.id);
      }
    });
    this.hooks.onToast(labels[sel.type]);
    this.select(null);
  }

  // ─── Outil mur ─────────────────────────────────────────────────────────────
  wallClick(w) {
    const pts = this.state.points || [];
    const from = pts[pts.length - 1] || null;
    const snap = this.snapPoint(w, { from, freeAngle: this.keys.shift });
    this.addWallPoint(snap.point);
  }

  addWallPoint(p) {
    const pts = this.state.points || (this.state.points = []);
    if (pts.length && G.dist(pts[pts.length - 1], p) < 0.02) return;
    const closing = pts.length >= 2 && G.dist(pts[0], p) < 0.02;
    if (this.traceMode === 'axis' && pts.length) {
      const a = pts[pts.length - 1];
      const L = this.level;
      const type = this.wallType;
      this.store.commit('Tracer un mur', () => {
        M.addWall(this.store.project.levels.find((l) => l.id === L.id), a, p, { type });
      });
    }
    pts.push(p);
    if (closing) this.finishWall(true);
    this.invalidate();
  }

  applyTypedLength() {
    const value = parseFloat(this.typed);
    this.typed = null;
    this.hooks.onTyped?.(null);
    if (!Number.isFinite(value) || value <= 0 || !this.mouse) return;
    const pts = this.state.points;
    const from = pts[pts.length - 1];
    const snap = this.snapPoint(this.mouse.w, { from, freeAngle: this.keys.shift });
    const dir = snap.dir || G.norm(G.sub(this.mouse.w, from));
    this.addWallPoint(G.add(from, G.mul(dir, value)));
  }

  finishWall(closed = false) {
    if (this.traceMode === 'edge' && (this.state.points?.length || 0) > 1) this.commitEdgeChain(closed);
    this.state = {};
    this.typed = null;
    this.hooks.onTyped?.(null);
    this.invalidate();
  }

  edgeChainAxis(points, closed) {
    const t = (WALL_TYPES[this.wallType]?.thickness || 0.2) / 2;
    let pts = points.slice();
    if (closed && G.dist(pts[0], pts[pts.length - 1]) < 0.02) pts.pop();
    if (closed) {
      // décalage d'un contour fermé : côté choisi par rapport au sens de tracé
      return { axis: G.offsetPolygon(pts, pts.map(() => t * this.edgeSide)), closed: true };
    }
    // polyligne ouverte : on ajoute des extrémités fictives
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
      const n1 = prev ? G.perp(G.norm(G.sub(cur, prev))) : null;
      const n2 = next ? G.perp(G.norm(G.sub(next, cur))) : null;
      if (!n1) { out.push(G.add(cur, G.mul(n2, t * this.edgeSide))); continue; }
      if (!n2) { out.push(G.add(cur, G.mul(n1, t * this.edgeSide))); continue; }
      const off = G.offsetPolygon([prev, cur, next], [t * this.edgeSide, t * this.edgeSide, 0]);
      const cand = off[1];
      out.push(cand && G.dist(cand, cur) < 5 * t ? cand : G.add(cur, G.mul(n2, t * this.edgeSide)));
    }
    return { axis: out, closed: false };
  }

  commitEdgeChain(closed) {
    const { axis, closed: isClosed } = this.edgeChainAxis(this.state.points, closed);
    const type = this.wallType;
    const levelId = this.levelId;
    this.store.commit('Tracer des murs', (pr) => {
      const L = pr.levels.find((l) => l.id === levelId);
      const n = axis.length;
      const segs = isClosed ? n : n - 1;
      for (let i = 0; i < segs; i++) M.addWall(L, axis[i], axis[(i + 1) % n], { type });
    });
  }

  // ─── Outil ouverture ───────────────────────────────────────────────────────
  openingPreview(w) {
    const L = this.level;
    let best = null;
    for (const wall of L.walls) {
      const a = L.nodes[wall.a], b = L.nodes[wall.b];
      const pr = G.projectOnSegment(w, a, b);
      if (pr.d < wall.thickness / 2 + this.px(14) && (!best || pr.d < best.d)) best = { wall, pr, a, b };
    }
    if (!best) return null;
    const cat = OPENING_TYPES[this.openingType];
    const Lw = G.dist(best.a, best.b);
    if (Lw < cat.width + 0.1) return { type: 'openingPreview', invalid: true, wallId: best.wall.id };
    const grid = DEFAULTS.gridStep;
    let offset = Math.round((best.pr.t * Lw) / grid) * grid;
    offset = Math.max(cat.width / 2 + 0.05, Math.min(Lw - cat.width / 2 - 0.05, offset));
    const u = G.norm(G.sub(best.b, best.a));
    const side = G.cross(u, G.sub(w, best.a)) > 0 ? 1 : -1;
    // collision avec une autre ouverture
    const clash = best.wall.openings.some((o) => Math.abs(o.offset - offset) < (o.width + cat.width) / 2 + 0.02);
    return { type: 'openingPreview', wallId: best.wall.id, offset, side, clash, width: cat.width };
  }

  openingClick(w) {
    const pv = this.openingPreview(w);
    if (!pv || pv.invalid) { this.hooks.onToast(pv?.invalid ? 'Ce mur est trop court pour cette ouverture.' : 'Cliquez sur un mur pour poser l’ouverture.', 'warn'); return; }
    if (pv.clash) { this.hooks.onToast('Une ouverture occupe déjà cet emplacement.', 'warn'); return; }
    const cat = OPENING_TYPES[this.openingType];
    const id = M.uid('o');
    this.store.commit(`Poser : ${cat.label}`, () => {
      const wall = this.level.walls.find((x) => x.id === pv.wallId);
      wall.openings.push({ id, type: this.openingType, kind: cat.kind, offset: pv.offset, width: cat.width, height: cat.height, sill: cat.sill, side: pv.side, hinge: 'start' });
    });
    this.select({ type: 'opening', id, wallId: pv.wallId });
  }

  // ─── Échelle, mesure, calage ───────────────────────────────────────────────
  freePoint(w) {
    // aimantation légère : nœuds uniquement
    for (const p of Object.values(this.level.nodes)) if (G.dist(w, p) < this.px(8)) return p.slice();
    return w;
  }

  async scaleClick(w) {
    const plan = this.level.plan;
    if (!plan) { this.hooks.onToast("Importez d'abord un plan (étape 1).", 'warn'); return; }
    const pts = this.state.points || (this.state.points = []);
    let p = w;
    if (pts.length === 1 && !this.keys.shift) {
      // contrainte horizontale/verticale pour faciliter la mesure d'une cote
      const v = G.sub(w, pts[0]);
      p = Math.abs(v[0]) > Math.abs(v[1]) ? [w[0], pts[0][1]] : [pts[0][0], w[1]];
    }
    pts.push(p);
    this.invalidate();
    if (pts.length < 2) return;
    const measured = G.dist(pts[0], pts[1]);
    const real = await this.hooks.requestScaleDistance(measured);
    if (real && real > 0 && measured > 0) {
      this.store.commit("Régler l'échelle", () => {
        const pl = this.level.plan;
        M.rescalePlan(pl, real / measured, pts[0]);
        pl.calibrated = true;
      });
      this.hooks.onToast(`Échelle réglée. Vérifiez avec l'outil Mesurer sur une autre cote.`);
      this.fit();
      this.state = {};
      this.hooks.requestTool?.('measure');
      return;
    }
    this.state = {};
    this.invalidate();
  }

  measureClick(w) {
    const pts = this.state.points && this.state.points.length < 2 ? this.state.points : (this.state.points = []);
    let p = this.freePoint(w);
    if (pts.length === 1 && !this.keys.shift) {
      const v = G.sub(p, pts[0]);
      if (Math.abs(v[0]) > 4 * Math.abs(v[1])) p = [p[0], pts[0][1]];
      else if (Math.abs(v[1]) > 4 * Math.abs(v[0])) p = [pts[0][0], p[1]];
    }
    pts.push(p);
    this.invalidate();
  }

  calageClick(w) {
    const plan = this.level.plan;
    if (!plan) return;
    const pts = this.state.points || (this.state.points = []);
    if (pts.length === 0) { pts.push(w); this.invalidate(); return; }
    // second clic : cible, aimantée sur l'étage inférieur
    let target = w;
    const below = this.levelBelow;
    if (below) {
      for (const p of Object.values(below.nodes)) if (G.dist(w, p) < this.px(12)) target = p.slice();
    }
    const src = pts[0];
    this.store.commit('Caler le plan', () => {
      const pl = this.level.plan;
      pl.x += target[0] - src[0];
      pl.y += target[1] - src[1];
    });
    this.hooks.onToast('Plan calé sur le repère.');
    this.state = {};
    this.invalidate();
  }

  // Aimantation sur les points de repère (niveau courant et niveau inférieur)
  anchorPoint(w) {
    const cands = [...Object.values(this.level.nodes), ...(this.levelBelow ? Object.values(this.levelBelow.nodes) : [])];
    let best = null;
    for (const p of cands) {
      const d = G.dist(w, p);
      if (d < this.px(12) && (!best || d < best.d)) best = { d, p };
    }
    return best ? best.p.slice() : w;
  }

  // Calage complet d'un plan : deux couples de points donnent l'échelle, la rotation et la position.
  align2Click(w) {
    if (!this.level.plan) { this.hooks.onToast("Importez d'abord un plan.", 'warn'); return; }
    const pts = this.state.points || (this.state.points = []);
    const isTarget = pts.length % 2 === 1;
    pts.push(isTarget ? this.anchorPoint(w) : w);
    this.invalidate();
    if (pts.length < 4) return;
    const [p1, q1, p2, q2] = pts;
    const base = G.dist(p1, p2);
    if (base < 0.05 || G.dist(q1, q2) < 0.05) {
      this.hooks.onToast('Choisissez deux repères nettement séparés.', 'warn');
      this.state = {};
      return;
    }
    const k = G.dist(q1, q2) / base;
    const theta = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]) - Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    const levelId = this.levelId;
    this.store.commit('Caler le plan', (pr) => {
      const plan = pr.levels.find((l) => l.id === levelId).plan;
      const rel = G.sub([plan.x, plan.y], p1);
      const c = Math.cos(theta), sn = Math.sin(theta);
      plan.x = q1[0] + k * (rel[0] * c - rel[1] * sn);
      plan.y = q1[1] + k * (rel[0] * sn + rel[1] * c);
      plan.scale *= k;
      plan.rotation = (((plan.rotation || 0) + (theta * 180) / Math.PI) % 360 + 360) % 360;
      plan.calibrated = true;
    });
    this.state = {};
    this.hooks.onToast(`Plan calé : échelle ajustée de ${((k - 1) * 100).toFixed(1).replace('.', ',')} % et pivoté de ${((theta * 180) / Math.PI).toFixed(1).replace('.', ',')}°.`);
    this.invalidate();
  }

  // ─── Fenêtres de toit ──────────────────────────────────────────────────────
  roofItems() {
    const out = [];
    for (const body of this.project.bodies) {
      const idx = M.bodyTopLevelIndex(this.project, body.id);
      if (idx < 0 || this.project.levels[idx].id !== this.levelId) continue;
      for (const o of roofOpenings(this.project, this.level, body)) out.push(o);
    }
    return out;
  }

  // Corps couvert au-dessus d'un point : la toiture d'un corps est portée par le niveau
  // le plus haut où il possède des pièces, qui n'est pas forcément le niveau affiché.
  bodyAtRoof(p, quiet = false) {
    let disabled = null;
    for (const body of this.project.bodies) {
      const idx = M.bodyTopLevelIndex(this.project, body.id);
      if (idx < 0) continue;
      const level = this.project.levels[idx];
      for (const outline of M.bodyOutlines(this.project, level, body.id, 1)) {
        const baseZ = M.levelElevation(this.project, level.id) + (body.elevation || 0) + M.bodyHeight(this.project, level, body);
        const roof = G.buildRoof(outline, { ...body.roof, enabled: true, baseZ });
        if (!roof.faces.some((f) => G.pointInPolygon(p, f.poly.map((q) => [q[0], q[1]])))) continue;
        const face = roof.faces.find((f) => G.pointInPolygon(p, f.poly.map((q) => [q[0], q[1]])));
        if (!body.roof?.enabled) { disabled = body; continue; }
        return { body, level, face };
      }
    }
    if (disabled && !quiet) this.hooks.onToast(`La toiture de « ${disabled.name} » est désactivée : activez-la pour y poser une fenêtre.`, 'warn');
    return null;
  }

  // Aperçu au survol : on montre le pan détecté et l'emplacement de la future fenêtre.
  skylightPreview(w) {
    let hit = null;
    try { hit = this.bodyAtRoof(w, true); } catch { hit = null; }
    if (!hit) return { type: 'skylightPreview', ok: false };
    const { body, level, face } = hit;
    const probe = { ...this.newRoofItem('preview', level.id, w) };
    const previous = body.roofItems || [];
    body.roofItems = [...previous, probe];
    let info = null;
    try {
      info = roofOpenings(this.project, level, body).find((o) => o.item.id === 'preview') || null;
    } finally {
      body.roofItems = previous;
    }
    return { type: 'skylightPreview', ok: true, body, level, face, info, enabled: !!body.roof?.enabled };
  }

  newRoofItem(id, levelId, w) {
    const preset = ROOF_OPENINGS[this.roofOpeningType] || ROOF_OPENINGS.skylight;
    const base = { id, type: this.roofOpeningType, kind: preset.kind, level: levelId, x: w[0], y: w[1] };
    if (preset.kind === 'dormer') {
      return { ...base, width: preset.width, wallHeight: preset.wallHeight, pitch: preset.pitch, depth: preset.depth, setback: preset.setback, winHeight: preset.winHeight, winSill: preset.winSill };
    }
    return { ...base, width: preset.width, height: preset.height, sill: preset.sill };
  }

  skylightClick(w) {
    const hit = this.bodyAtRoof(w);
    if (!hit) {
      if (!this.project.bodies.some((b) => b.roof?.enabled === false)) {
        this.hooks.onToast("Aucun pan de toiture à cet endroit : cliquez à l'intérieur du bâtiment.", 'warn');
      }
      return;
    }
    const { body, level } = hit;
    const id = M.uid('sk');
    this.store.commit('Poser une fenêtre de toit', (pr) => {
      const b = M.bodyById(pr, body.id);
      b.roofItems = [...(b.roofItems || []), this.newRoofItem(id, level.id, w)];
    });
    if (level.id !== this.levelId) this.hooks.requestLevel?.(level.id);
    const info = roofOpenings(this.project, level, M.bodyById(this.project, body.id)).find((o) => o.item.id === id);
    const label = (ROOF_OPENINGS[this.roofOpeningType] || ROOF_OPENINGS.skylight).label;
    const allege = info?.poly && info.preset?.kind !== 'dormer' ? ` Allège ${(info.sillZ - info.floorZ).toFixed(2).replace('.', ',')} m.` : '';
    this.hooks.onToast(`${label} posée sur « ${body.name} ».${allege}`);
    this.select({ type: 'roofitem', id, bodyId: body.id });
  }

  // ─── Statut ────────────────────────────────────────────────────────────────
  updateStatus() {
    const hints = {
      select: 'Cliquez un élément pour le modifier. Glissez un angle, un mur ou une ouverture pour le déplacer.',
      wall: this.state.points?.length
        ? 'Cliquez le point suivant ou tapez une longueur puis Entrée. Échap ou double-clic pour terminer. Maj : angle libre.'
        : 'Cliquez le point de départ du mur.',
      opening: 'Survolez un mur puis cliquez pour poser. La porte s’ouvre du côté de la souris.',
      scale: this.state.points?.length ? 'Cliquez la fin de la cote connue.' : 'Cliquez le début d’une cote dont vous connaissez la longueur (idéalement la plus longue).',
      measure: 'Cliquez deux points pour mesurer une distance.',
      calage: this.state.points?.length ? 'Cliquez maintenant le même point sur l’étage inférieur (en gris).' : 'Cliquez un repère sur le plan (un angle de façade par exemple).',
      align2: ['Repère 1 : cliquez un angle sur le plan.', 'Cliquez le même angle sur l’étage inférieur (en gris).', 'Repère 2 : cliquez un second angle sur le plan, éloigné du premier.', 'Cliquez ce second angle sur l’étage inférieur.'][(this.state.points?.length || 0) % 4],
      movePlan: 'Glissez le plan pour le positionner.',
      skylight: this.hover?.type === 'skylightPreview' && this.hover.ok
        ? `Pan de « ${this.hover.body.name} » sous le curseur : cliquez pour poser la fenêtre.`
        : 'Aucun pan de toiture sous le curseur. Visez l’intérieur d’un bâtiment couvert.',
    };
    const w = this.mouse?.w;
    this.hooks.onStatus?.({
      hint: hints[this.tool],
      coords: w ? `x ${w[0].toFixed(2)}  y ${(-w[1]).toFixed(2)}` : '',
      snap: this.snapInfo?.label || '',
      zoom: this.view.zoom,
    });
  }

  // ─── Rendu ─────────────────────────────────────────────────────────────────
  render() {
    const ctx = this.ctx;
    const L = this.level;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#e6e9eb';
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawGrid();
    this.drawPlan(L.plan);

    const below = this.levelBelow;
    if (below) this.drawGhost(below);

    const { rooms } = M.levelFaces(L);
    const polys = G.computeWallPolygons(L);
    for (const r of rooms) this.drawRoomFill(r);
    for (const wall of L.walls) this.drawWall(L, wall, polys.get(wall.id));
    this.drawNodes(L);
    for (const r of rooms) this.drawRoomLabel(r);
    this.drawRoofItems();
    this.drawSelection(L, polys);
    this.drawTool(L);
  }

  pathPoly(poly) {
    const ctx = this.ctx;
    ctx.beginPath();
    poly.forEach((p, i) => {
      const s = this.toScreen(p);
      if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
    });
    ctx.closePath();
  }

  drawGrid() {
    const ctx = this.ctx;
    const z = this.view.zoom;
    const steps = [0.1, 0.5, 1, 5, 10];
    const tl = this.toWorld([0, 0]), br = this.toWorld([this.w, this.h]);
    for (const step of steps) {
      const spacing = step * z;
      if (spacing < 12) continue;
      const major = step >= 1 && spacing > 30;
      ctx.strokeStyle = major ? 'rgba(31,42,48,0.09)' : 'rgba(31,42,48,0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = Math.floor(tl[0] / step) * step; x <= br[0]; x += step) {
        const sx = Math.round(this.toScreen([x, 0])[0]) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h);
      }
      for (let y = Math.floor(tl[1] / step) * step; y <= br[1]; y += step) {
        const sy = Math.round(this.toScreen([0, y])[1]) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(this.w, sy);
      }
      ctx.stroke();
      if (spacing > 60) break;
    }
    // origine
    const o = this.toScreen([0, 0]);
    ctx.strokeStyle = 'rgba(232,103,42,0.5)';
    ctx.beginPath();
    ctx.moveTo(o[0] - 8, o[1]); ctx.lineTo(o[0] + 8, o[1]);
    ctx.moveTo(o[0], o[1] - 8); ctx.lineTo(o[0], o[1] + 8);
    ctx.stroke();
  }

  drawPlan(plan) {
    if (!plan) return;
    const img = this.imageFor(plan);
    if (!img) return;
    const ctx = this.ctx;
    const o = this.toScreen([plan.x, plan.y]);
    ctx.save();
    ctx.globalAlpha = plan.opacity ?? 0.55;
    ctx.translate(o[0], o[1]);
    ctx.rotate(((plan.rotation || 0) * Math.PI) / 180);
    const k = plan.scale * this.view.zoom;
    ctx.scale(k, k);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  drawGhost(level) {
    const ctx = this.ctx;
    const polys = G.computeWallPolygons(level);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(31,42,48,0.35)';
    ctx.fillStyle = 'rgba(31,42,48,0.06)';
    ctx.lineWidth = 1;
    for (const poly of polys.values()) { this.pathPoly(poly); ctx.fill(); ctx.stroke(); }
    ctx.restore();
    if (this.tool === 'calage' || this.tool === 'align2' || this.tool === 'wall') {
      ctx.fillStyle = 'rgba(31,42,48,0.45)';
      for (const p of Object.values(level.nodes)) {
        const s = this.toScreen(p);
        ctx.fillRect(s[0] - 2, s[1] - 2, 4, 4);
      }
    }
  }

  bodyTint(room) {
    const bodies = this.project.bodies || [];
    const i = Math.max(0, bodies.findIndex((b) => b.id === room?.bodyId));
    return BODY_TINTS[i % BODY_TINTS.length];
  }

  drawRoomFill(r) {
    if (!r.room) return;
    const sel = this.selection?.type === 'room' && this.selection.id === r.room.id;
    const hov = this.hover?.type === 'room' && this.hover.id === r.room.id;
    const tint = this.bodyTint(r.room);
    this.pathPoly(r.net);
    this.ctx.fillStyle = sel ? ROOM_FILL_SEL : hov ? tint.hover : tint.fill;
    this.ctx.fill();
  }

  drawRoomLabel(r) {
    if (!r.room || r.area < 0.5) return;
    const ctx = this.ctx;
    const p = this.toScreen(G.interiorPoint(r.net));
    const z = this.view.zoom;
    if (z < 12) return;
    const size = Math.max(10, Math.min(15, z * 0.28));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tint = this.bodyTint(r.room);
    const bodies = this.project.bodies || [];
    const body = bodies.find((b) => b.id === r.room.bodyId);
    const showBody = bodies.length > 1 && body;
    const dy = showBody ? size * 0.95 : size * 0.55;
    ctx.font = `500 ${size}px "Instrument Sans", system-ui, sans-serif`;
    ctx.fillStyle = tint.ink;
    ctx.fillText(r.room.name, p[0], p[1] - dy);
    ctx.font = `400 ${size * 0.9}px "Instrument Sans", system-ui, sans-serif`;
    ctx.fillStyle = tint.ink + 'cc';
    ctx.fillText(fmtArea(r.area), p[0], p[1] + (showBody ? 0 : size * 0.65));
    if (showBody) {
      ctx.font = `500 ${size * 0.75}px "Instrument Sans", system-ui, sans-serif`;
      ctx.fillStyle = tint.ink + '99';
      ctx.fillText(body.name.toUpperCase(), p[0], p[1] + size * 1.05);
    }
  }

  drawWall(L, wall, poly) {
    if (!poly) return;
    const ctx = this.ctx;
    const cat = WALL_TYPES[wall.type]?.category || 'interior';
    const a = L.nodes[wall.a], b = L.nodes[wall.b];
    const u = G.norm(G.sub(b, a));
    const Lw = G.dist(a, b);
    const ops = [...wall.openings].sort((m, n) => m.offset - n.offset);
    // morceaux pleins
    let cursor = null;
    const slices = [];
    const slice = (s, e) => {
      let p = poly;
      if (s !== null) p = G.clipHalfPlane(p, a, u, s, true);
      if (e !== null) p = G.clipHalfPlane(p, a, u, e, false);
      return p.length >= 3 ? p : null;
    };
    for (const o of ops) {
      const s = Math.max(0, o.offset - o.width / 2), e = Math.min(Lw, o.offset + o.width / 2);
      const sl = slice(cursor, s); if (sl) slices.push(sl);
      cursor = e;
    }
    const last = slice(cursor, null); if (last) slices.push(last);
    ctx.fillStyle = WALL_FILL[cat];
    for (const sl of slices) { this.pathPoly(sl); ctx.fill(); }

    // symboles d'ouvertures
    const n = G.perp(u);
    const h = wall.thickness / 2;
    for (const o of ops) {
      const s = o.offset - o.width / 2, e = o.offset + o.width / 2;
      const P = (t, k) => this.toScreen(G.add(G.add(a, G.mul(u, t)), G.mul(n, k)));
      ctx.lineWidth = 1;
      ctx.strokeStyle = INK;
      // tableaux
      ctx.beginPath();
      for (const t of [s, e]) { const p1 = P(t, -h), p2 = P(t, h); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
      ctx.stroke();
      if (o.kind === 'window') {
        ctx.strokeStyle = '#3f7fa0';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (const k of [-h / 3, h / 3]) { const p1 = P(s, k), p2 = P(e, k); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
        if (o.sill < 0.05) { const p1 = P(s, 0), p2 = P(e, 0); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
        ctx.stroke();
      } else {
        const side = o.side || 1;
        const hingeAtStart = (o.hinge || 'start') === 'start';
        const tH = hingeAtStart ? s : e, tF = hingeAtStart ? e : s;
        const face = side * h;
        const hinge = P(tH, face);
        const leafEnd = this.toScreen(G.add(G.add(a, G.mul(u, tH)), G.mul(n, face + side * o.width)));
        const closedEnd = P(tF, face);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(hinge[0], hinge[1]);
        ctx.lineTo(leafEnd[0], leafEnd[1]);
        ctx.stroke();
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        const r = o.width * this.view.zoom;
        const a0 = Math.atan2(leafEnd[1] - hinge[1], leafEnd[0] - hinge[0]);
        const a1 = Math.atan2(closedEnd[1] - hinge[1], closedEnd[0] - hinge[0]);
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        ctx.arc(hinge[0], hinge[1], r, a0, a0 + delta, delta < 0);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  drawNodes(L) {
    if (!(this.tool === 'select' || this.tool === 'wall')) return;
    const ctx = this.ctx;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    for (const [id, p] of Object.entries(L.nodes)) {
      const s = this.toScreen(p);
      const hov = this.hover?.type === 'node' && this.hover.id === id;
      const r = hov ? 5 : 2.5;
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawDimension(p1, p2, offsetPx, text, color = INK) {
    const ctx = this.ctx;
    const s1 = this.toScreen(p1), s2 = this.toScreen(p2);
    const d = G.norm(G.sub(s2, s1));
    const n = G.perp(d);
    const o = G.mul(n, offsetPx);
    const a = G.add(s1, o), b = G.add(s2, o);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    for (const [q, base] of [[a, s1], [b, s2]]) {
      ctx.moveTo(base[0] + n[0] * offsetPx * 0.3, base[1] + n[1] * offsetPx * 0.3);
      ctx.lineTo(q[0] + n[0] * 4 * Math.sign(offsetPx || 1), q[1] + n[1] * 4 * Math.sign(offsetPx || 1));
      ctx.moveTo(q[0] - d[0] * 4 - n[0] * 4, q[1] - d[1] * 4 - n[1] * 4);
      ctx.lineTo(q[0] + d[0] * 4 + n[0] * 4, q[1] + d[1] * 4 + n[1] * 4);
    }
    ctx.stroke();
    const m = G.mul(G.add(a, b), 0.5);
    let ang = Math.atan2(d[1], d[0]);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    ctx.save();
    ctx.translate(m[0], m[1]);
    ctx.rotate(ang);
    ctx.font = '500 12px "Instrument Sans", system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(251,251,250,0.95)';
    ctx.fillRect(-tw / 2, -9, tw, 18);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  drawRoofItems() {
    const ctx = this.ctx;
    for (const o of this.roofItems()) {
      if (!o.poly) continue;
      const sel = this.selection?.type === 'roofitem' && this.selection.id === o.item.id;
      if (o.preset?.kind === 'dormer') {
        this.pathPoly(o.poly);
        ctx.fillStyle = sel ? 'rgba(232,103,42,0.22)' : 'rgba(155,90,67,0.20)';
        ctx.fill();
        ctx.strokeStyle = sel ? ACCENT : '#9b5a43';
        ctx.lineWidth = sel ? 2 : 1.3;
        ctx.stroke();
        // façade de la lucarne, trait plein
        const a = o.poly[0], b = o.poly[o.poly.length - 1];
        const s1 = this.toScreen(a), s2 = this.toScreen(b);
        ctx.lineWidth = sel ? 3 : 2.2;
        ctx.beginPath(); ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s2[0], s2[1]); ctx.stroke();
        continue;
      }
      // au-delà d'un certain dézoom, le symbole devient illisible : on pose un repère
      if (o.item.width * this.view.zoom < 10) {
        const c = this.toScreen(G.polygonCentroid(o.poly));
        ctx.beginPath();
        ctx.moveTo(c[0], c[1] - 7); ctx.lineTo(c[0] + 7, c[1]); ctx.lineTo(c[0], c[1] + 7); ctx.lineTo(c[0] - 7, c[1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(63,127,160,0.35)';
        ctx.fill();
        ctx.strokeStyle = sel ? ACCENT : '#3f7fa0';
        ctx.lineWidth = sel ? 2 : 1.2;
        ctx.stroke();
        continue;
      }
      this.pathPoly(o.poly);
      ctx.fillStyle = 'rgba(63,127,160,0.16)';
      ctx.fill();
      ctx.strokeStyle = sel ? ACCENT : '#3f7fa0';
      ctx.lineWidth = sel ? 2 : 1.2;
      ctx.stroke();
      const s0 = this.toScreen(o.poly[0]), s1 = this.toScreen(o.poly[1]), s2 = this.toScreen(o.poly[2]), s3 = this.toScreen(o.poly[3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s2[0], s2[1]);
      ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s3[0], s3[1]);
      ctx.stroke();
      if (this.view.zoom > 25) {
        const c = this.toScreen(G.polygonCentroid(o.poly));
        ctx.font = '500 11px "Instrument Sans", system-ui, sans-serif';
        ctx.fillStyle = o.clamped ? ACCENT : '#3f7fa0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`allège ${(o.sillZ - o.floorZ).toFixed(2).replace('.', ',')} m`, c[0], c[1] + 10);
      }
    }
  }

  drawSelection(L, polys) {
    const ctx = this.ctx;
    const mark = (sel, color, width) => {
      if (!sel) return;
      if (sel.type === 'wall') {
        const poly = polys.get(sel.id);
        if (!poly) return;
        this.pathPoly(poly);
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
        const wall = L.walls.find((x) => x.id === sel.id);
        if (wall && color === ACCENT) {
          const a = L.nodes[wall.a], b = L.nodes[wall.b];
          this.drawDimension(a, b, -(wall.thickness / 2) * this.view.zoom - 16, fmtLen(G.dist(a, b)), ACCENT);
        }
      } else if (sel.type === 'opening') {
        const wall = L.walls.find((x) => x.id === sel.wallId);
        const o = wall?.openings.find((x) => x.id === sel.id);
        if (!o) return;
        const a = L.nodes[wall.a], b = L.nodes[wall.b];
        const u = G.norm(G.sub(b, a)), n = G.perp(u);
        const h = wall.thickness / 2 + this.px(3);
        const c = G.add(a, G.mul(u, o.offset));
        const q = [
          G.add(G.add(c, G.mul(u, -o.width / 2)), G.mul(n, -h)), G.add(G.add(c, G.mul(u, o.width / 2)), G.mul(n, -h)),
          G.add(G.add(c, G.mul(u, o.width / 2)), G.mul(n, h)), G.add(G.add(c, G.mul(u, -o.width / 2)), G.mul(n, h)),
        ];
        this.pathPoly(q);
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
        if (color === ACCENT) {
          const off = -(wall.thickness / 2) * this.view.zoom - 16;
          const s = o.offset - o.width / 2, e = o.offset + o.width / 2;
          if (s > 0.02) this.drawDimension(a, G.add(a, G.mul(u, s)), off, fmtLen(s), INK_SOFT);
          this.drawDimension(G.add(a, G.mul(u, s)), G.add(a, G.mul(u, e)), off, fmtLen(o.width), ACCENT);
          const Lw = G.dist(a, b);
          if (Lw - e > 0.02) this.drawDimension(G.add(a, G.mul(u, e)), b, off, fmtLen(Lw - e), INK_SOFT);
        }
      } else if (sel.type === 'node') {
        const p = L.nodes[sel.id];
        if (!p) return;
        const s = this.toScreen(p);
        ctx.beginPath(); ctx.arc(s[0], s[1], 6, 0, Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
      }
    };
    if (this.tool === 'select' && this.hover && !this.drag) mark(this.hover, 'rgba(232,103,42,0.55)', 1.5);
    mark(this.selection, ACCENT, 2);
  }

  drawGuides(guides) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(232,103,42,0.7)';
    ctx.lineWidth = 1;
    for (const [p, q] of guides || []) {
      const a = this.toScreen(p), b = this.toScreen(q);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.restore();
  }

  drawSnapMarker(p, label) {
    const ctx = this.ctx;
    const s = this.toScreen(p);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (label === 'Angle' || label === 'Étage inférieur') ctx.rect(s[0] - 5, s[1] - 5, 10, 10);
    else if (label === 'Sur le mur') { ctx.moveTo(s[0] - 6, s[1] + 5); ctx.lineTo(s[0], s[1] - 5); ctx.lineTo(s[0] + 6, s[1] + 5); ctx.closePath(); }
    else { ctx.moveTo(s[0] - 6, s[1]); ctx.lineTo(s[0] + 6, s[1]); ctx.moveTo(s[0], s[1] - 6); ctx.lineTo(s[0], s[1] + 6); }
    ctx.stroke();
    if (label && label !== 'Grille') {
      ctx.font = '500 11px "Instrument Sans", system-ui, sans-serif';
      ctx.fillStyle = ACCENT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, s[0] + 9, s[1] + 7);
    }
  }

  drawTool(L) {
    const ctx = this.ctx;
    const m = this.mouse;
    if (this.tool === 'wall') {
      const pts = this.state.points || [];
      const from = pts[pts.length - 1] || null;
      if (!m) {
        this.snapInfo = null;
      } else {
        const snap = this.snapPoint(m.w, { from, freeAngle: this.keys.shift });
        this.snapInfo = snap;
        let target = snap.point;
        if (this.typed && from) {
          const v = parseFloat(this.typed);
          if (Number.isFinite(v)) target = G.add(from, G.mul(snap.dir || G.norm(G.sub(m.w, from)), v));
        }
        this.drawGuides(snap.guides);
        const chain = from ? [...pts, target] : [];
        const t = WALL_TYPES[this.wallType]?.thickness || 0.2;
        if (chain.length >= 2) {
          // bande du mur en préparation
          let axis = chain;
          if (this.traceMode === 'edge') axis = this.edgeChainAxis(chain, false).axis;
          const ghost = { nodes: {}, walls: [] };
          axis.forEach((p, i) => { ghost.nodes[`g${i}`] = p; });
          const startI = this.traceMode === 'axis' ? axis.length - 2 : 0;
          for (let i = startI; i + 1 < axis.length; i++) ghost.walls.push({ id: `gw${i}`, a: `g${i}`, b: `g${i + 1}`, thickness: t });
          const gp = G.computeWallPolygons(ghost);
          ctx.fillStyle = 'rgba(232,103,42,0.28)';
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 1;
          for (const poly of gp.values()) { this.pathPoly(poly); ctx.fill(); ctx.stroke(); }
          if (this.traceMode === 'edge') {
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            chain.forEach((p, i) => { const s = this.toScreen(p); if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]); });
            ctx.stroke();
            ctx.setLineDash([]);
          }
          const Ld = G.dist(from, target);
          this.drawDimension(from, target, -(t / 2) * this.view.zoom - 18, this.typed ? `${this.typed.replace('.', ',')} m` : fmtLen(Ld), ACCENT);
        }
        this.drawSnapMarker(target, snap.label);
      }
      if (pts.length) {
        const s = this.toScreen(pts[0]);
        ctx.strokeStyle = ACCENT;
        ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (this.tool === 'opening') {
      const pv = this.hover;
      if (pv && !pv.invalid) {
        const wall = L.walls.find((x) => x.id === pv.wallId);
        const a = L.nodes[wall.a], b = L.nodes[wall.b];
        const u = G.norm(G.sub(b, a)), n = G.perp(u);
        const h = wall.thickness / 2 + 0.03;
        const c = G.add(a, G.mul(u, pv.offset));
        const q = [
          G.add(G.add(c, G.mul(u, -pv.width / 2)), G.mul(n, -h)), G.add(G.add(c, G.mul(u, pv.width / 2)), G.mul(n, -h)),
          G.add(G.add(c, G.mul(u, pv.width / 2)), G.mul(n, h)), G.add(G.add(c, G.mul(u, -pv.width / 2)), G.mul(n, h)),
        ];
        this.pathPoly(q);
        ctx.fillStyle = pv.clash ? 'rgba(200,60,40,0.35)' : 'rgba(232,103,42,0.35)';
        ctx.fill();
        ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.stroke();
        const cat = OPENING_TYPES[this.openingType];
        if (cat.kind === 'door') {
          const hinge = G.add(G.add(c, G.mul(u, -pv.width / 2)), G.mul(n, pv.side * wall.thickness / 2));
          const leaf = G.add(hinge, G.mul(n, pv.side * pv.width));
          const s1 = this.toScreen(hinge), s2 = this.toScreen(leaf);
          ctx.beginPath(); ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s2[0], s2[1]); ctx.stroke();
        }
        const off = -(wall.thickness / 2) * this.view.zoom - 16;
        const s = pv.offset - pv.width / 2, e = pv.offset + pv.width / 2;
        this.drawDimension(a, G.add(a, G.mul(u, s)), off, fmtLen(s), ACCENT);
        this.drawDimension(G.add(a, G.mul(u, e)), b, off, fmtLen(G.dist(a, b) - e), ACCENT);
      } else if (pv?.invalid) {
        const wall = L.walls.find((x) => x.id === pv.wallId);
        const poly = G.computeWallPolygons(L).get(wall.id);
        if (poly) { this.pathPoly(poly); ctx.strokeStyle = '#c83c28'; ctx.lineWidth = 2; ctx.stroke(); }
      }
    } else if (this.tool === 'skylight') {
      const pv = this.hover;
      const m2 = this.mouse;
      if (pv?.ok && pv.face) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(63,127,160,0.9)';
        ctx.lineWidth = 1.5;
        this.pathPoly(pv.face.poly.map((p) => [p[0], p[1]]));
        ctx.stroke();
        ctx.restore();
        if (pv.info?.poly) {
          this.pathPoly(pv.info.poly);
          ctx.fillStyle = 'rgba(232,103,42,0.30)';
          ctx.fill();
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          const c = this.toScreen(G.polygonCentroid(pv.info.poly));
          ctx.font = '500 11px "Instrument Sans", system-ui, sans-serif';
          ctx.fillStyle = ACCENT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(`allège ${(pv.info.sillZ - pv.info.floorZ).toFixed(2).replace('.', ',')} m`, c[0], c[1] + 10);
        }
      } else if (m2) {
        const s = m2.s;
        ctx.strokeStyle = '#c83c28';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s[0], s[1], 9, 0, Math.PI * 2);
        ctx.moveTo(s[0] - 6, s[1] + 6); ctx.lineTo(s[0] + 6, s[1] - 6);
        ctx.stroke();
      }
    } else if (this.tool === 'scale' || this.tool === 'measure') {
      const pts = this.state.points || [];
      const color = this.tool === 'scale' ? ACCENT : '#2c5d55';
      let chain = pts.slice();
      if (m && pts.length === 1) {
        let p = this.tool === 'measure' ? this.freePoint(m.w) : m.w;
        if (!this.keys.shift) {
          const v = G.sub(p, pts[0]);
          if (this.tool === 'scale') p = Math.abs(v[0]) > Math.abs(v[1]) ? [p[0], pts[0][1]] : [pts[0][0], p[1]];
          else if (Math.abs(v[0]) > 4 * Math.abs(v[1])) p = [p[0], pts[0][1]];
          else if (Math.abs(v[1]) > 4 * Math.abs(v[0])) p = [pts[0][0], p[1]];
        }
        chain.push(p);
      }
      for (const p of chain) {
        const s = this.toScreen(p);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(s[0] - 7, s[1]); ctx.lineTo(s[0] + 7, s[1]); ctx.moveTo(s[0], s[1] - 7); ctx.lineTo(s[0], s[1] + 7); ctx.stroke();
      }
      if (chain.length === 2) {
        const text = this.tool === 'scale' && !L.plan?.calibrated ? 'à renseigner' : fmtLen(G.dist(chain[0], chain[1]));
        this.drawDimension(chain[0], chain[1], -14, text, color);
      }
    } else if (this.tool === 'align2') {
      const pts = this.state.points || [];
      const chain = [...pts];
      if (m) chain.push(chain.length % 2 === 1 ? this.anchorPoint(m.w) : m.w);
      chain.forEach((p, i) => {
        const s = this.toScreen(p);
        ctx.strokeStyle = i % 2 ? ACCENT : INK;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (i % 2) ctx.rect(s[0] - 5, s[1] - 5, 10, 10);
        else { ctx.moveTo(s[0] - 7, s[1]); ctx.lineTo(s[0] + 7, s[1]); ctx.moveTo(s[0], s[1] - 7); ctx.lineTo(s[0], s[1] + 7); }
        ctx.stroke();
        ctx.font = '500 11px "Instrument Sans", system-ui, sans-serif';
        ctx.fillStyle = i % 2 ? ACCENT : INK;
        ctx.textAlign = 'left';
        ctx.fillText(i % 2 ? `cible ${Math.floor(i / 2) + 1}` : `repère ${Math.floor(i / 2) + 1}`, s[0] + 9, s[1] - 9);
      });
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(232,103,42,0.8)';
      for (let i = 0; i + 1 < chain.length; i += 2) {
        const a = this.toScreen(chain[i]), b = this.toScreen(chain[i + 1]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      ctx.setLineDash([]);
    } else if (this.tool === 'calage') {
      const pts = this.state.points || [];
      if (pts.length && m) {
        let target = m.w;
        const below = this.levelBelow;
        if (below) for (const p of Object.values(below.nodes)) if (G.dist(m.w, p) < this.px(12)) target = p;
        const a = this.toScreen(pts[0]), b = this.toScreen(target);
        ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(a[0], a[1], 5, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeRect(b[0] - 5, b[1] - 5, 10, 10);
      }
    }
  }
}
