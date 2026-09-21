// Smelt Studio - équipements intérieurs.
// Extension volontairement isolée : elle réutilise l'UI et le modèle existants
// sans modifier le moteur murs / ouvertures / pièces / toiture.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as M from './model.js';
import * as G from './geometry.js';
import { View3D, buildObject3D } from './view3d.js';
import { EQUIPMENT_TYPES, EQUIPMENT_GROUPS } from './equipment-catalog.js';
import { equipmentParts, placeEquipment as placeParts, EQUIPMENT_MATERIALS } from './equipment-models.js';

export { EQUIPMENT_TYPES } from './equipment-catalog.js';
const state = {
  active: false,
  type: 'wc',
  previewRotation: 0,
  selectedId: null,
  refreshing: false,
  storeBound: false,
};

const GRID = 0.05;
const ACCENT = '#e8672a';
const INK = '#1f2a30';
const SOFT = '#56626a';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmt = (v, d = 2) => Number(v).toFixed(d).replace('.', ',');
const parseNum = (v) => parseFloat(String(v).replace(',', '.'));
const deg = (a) => ((a % 360) + 360) % 360;

function toast(message, kind = '') {
  const root = document.querySelector('#toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), kind === 'warn' ? 4200 : 2600);
}

// Les premiers projets ont hérité des dimensions des anciens GLB (boîte englobante
// comprenant le robinet, receveur de douche seul…). On les ramène aux valeurs métier.
const LEGACY_FIXES = [
  { type: 'sink', test: (it) => Math.abs(it.height - 1.123) < 0.02, fix: { height: 0.90 } },
  { type: 'shower', test: (it) => it.height < 0.3, fix: { height: 2.00 } },
  { type: 'basin', test: (it) => Math.abs(it.height - 0.928) < 0.02, fix: { height: 0.85 } },
];

function ensureEquipment(level) {
  if (!Array.isArray(level.equipment)) level.equipment = [];
  for (const it of level.equipment) {
    if (it.__migrated) continue;
    for (const rule of LEGACY_FIXES) if (it.type === rule.type && rule.test(it)) Object.assign(it, rule.fix);
    Object.defineProperty(it, '__migrated', { value: true, enumerable: false });
  }
  return level.equipment;
}

function equipment(editor, id) {
  return ensureEquipment(editor.level).find((x) => x.id === id) || null;
}

function roomInfoAt(level, p) {
  return M.levelFaces(level).rooms.find((r) => r.room && G.pointInPolygon(p, r.net)) || null;
}

function roomForItem(level, item) {
  const byId = M.levelFaces(level).rooms.find((r) => r.room?.id === item.roomId);
  if (byId && G.pointInPolygon([item.x, item.y], byId.net)) return byId;
  return roomInfoAt(level, [item.x, item.y]);
}

function floorZ(project, level, item) {
  const info = roomForItem(level, item);
  const body = info?.room ? M.bodyById(project, info.room.bodyId) : M.bodyById(project, project.activeBodyId);
  return M.levelElevation(project, level.id) + (body?.elevation || 0);
}

function snap(v) {
  return Math.round(v / GRID) * GRID;
}

function localPoint(item, p) {
  const a = -(item.rotation || 0) * Math.PI / 180;
  const dx = p[0] - item.x;
  const dy = p[1] - item.y;
  return [
    dx * Math.cos(a) - dy * Math.sin(a),
    dx * Math.sin(a) + dy * Math.cos(a),
  ];
}

function equipmentHit(editor, p) {
  const tol = editor.px(5);
  const items = ensureEquipment(editor.level);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const q = localPoint(it, p);
    if (Math.abs(q[0]) <= it.width / 2 + tol && Math.abs(q[1]) <= it.depth / 2 + tol) {
      return { type: 'equipment', id: it.id };
    }
  }
  return null;
}

function drawPlanSymbol(editor, item, alpha = 1, preview = false) {
  const ctx = editor.ctx;
  const cat = EQUIPMENT_TYPES[item.type] || EQUIPMENT_TYPES.baseCabinet;
  const s = editor.toScreen([item.x, item.y]);
  const z = editor.view.zoom;
  const w = item.width;
  const d = item.depth;
  const angle = (item.rotation || 0) * Math.PI / 180;
  const selected = state.selectedId === item.id;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(s[0], s[1]);
  ctx.rotate(angle);
  ctx.scale(z, z);
  ctx.lineWidth = (selected ? 2 : 1.2) / z;
  ctx.strokeStyle = selected ? ACCENT : INK;
  ctx.fillStyle = preview ? 'rgba(232,103,42,0.14)' : 'rgba(251,251,250,0.92)';
  ctx.fillRect(-w / 2, -d / 2, w, d);
  ctx.strokeRect(-w / 2, -d / 2, w, d);

  ctx.lineWidth = 1 / z;
  ctx.strokeStyle = selected ? ACCENT : SOFT;

  if (item.type === 'wc') {
    ctx.strokeRect(-w * 0.38, -d * 0.48, w * 0.76, d * 0.20);
    ctx.beginPath();
    ctx.ellipse(0, d * 0.10, w * 0.32, d * 0.28, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (item.type === 'basin' || item.type === 'sink') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.34, d * 0.30, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -d * 0.12, Math.min(w, d) * 0.035, 0, Math.PI * 2);
    ctx.stroke();
  } else if (item.type === 'shower') {
    ctx.beginPath();
    ctx.moveTo(-w / 2, -d / 2);
    ctx.lineTo(w / 2, d / 2);
    ctx.moveTo(w / 2, -d / 2);
    ctx.lineTo(-w / 2, d / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w * 0.32, d * 0.32, Math.min(w, d) * 0.04, 0, Math.PI * 2);
    ctx.stroke();
  } else if (item.type === 'bath') {
    ctx.strokeRect(-w * 0.42, -d * 0.34, w * 0.84, d * 0.68);
  } else if (item.type === 'cooktop') {
    for (const x of [-0.18, 0.18]) for (const y of [-0.18, 0.18]) {
      ctx.beginPath();
      ctx.arc(x * w, y * d, Math.min(w, d) * 0.10, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (item.type === 'bedDouble' || item.type === 'bedSingle') {
    const pillows = w > 1.2 ? 2 : 1;
    const pw = (w - 0.1) / pillows - 0.05;
    for (let i = 0; i < pillows; i++) ctx.strokeRect(-w / 2 + 0.075 + (pw + 0.05) * i, -d / 2 + 0.1, pw, 0.3);
    ctx.beginPath(); ctx.moveTo(-w / 2, -d / 2 + 0.55); ctx.lineTo(w / 2, -d / 2 + 0.55); ctx.stroke();
  } else if (item.type === 'sofa') {
    ctx.strokeRect(-w / 2, -d / 2, w, 0.22);
    ctx.strokeRect(-w / 2, -d / 2, 0.18, d);
    ctx.strokeRect(w / 2 - 0.18, -d / 2, 0.18, d);
  } else if (item.type === 'wardrobe') {
    ctx.beginPath(); ctx.moveTo(-w / 2, -d / 2); ctx.lineTo(w / 2, d / 2); ctx.moveTo(w / 2, -d / 2); ctx.lineTo(-w / 2, d / 2); ctx.stroke();
  } else if (item.type === 'washer') {
    ctx.beginPath(); ctx.arc(0, 0, Math.min(w, d) * 0.3, 0, Math.PI * 2); ctx.stroke();
  } else if (item.type === 'chair') {
    ctx.beginPath(); ctx.moveTo(-w / 2, -d / 2 + 0.05); ctx.lineTo(w / 2, -d / 2 + 0.05); ctx.stroke();
  } else if (item.type === 'radiator' || item.type === 'towelDryer') {
    const n = Math.max(3, Math.round(w / 0.08));
    ctx.beginPath();
    for (let i = 1; i < n; i++) { const x = -w / 2 + (w / n) * i; ctx.moveTo(x, -d / 2); ctx.lineTo(x, d / 2); }
    ctx.stroke();
  } else if (item.type === 'hood' || item.type === 'wallCabinet') {
    ctx.setLineDash([0.05, 0.04]);
    ctx.strokeRect(-w / 2 + 0.02, -d / 2 + 0.02, w - 0.04, d - 0.04);
    ctx.setLineDash([]);
  } else if (item.type === 'fridge') {
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2, 0);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2, 0);
    ctx.stroke();
  }
  ctx.restore();

  if (z > 25 && !preview) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '500 10px "Instrument Sans", system-ui, sans-serif';
    ctx.fillStyle = selected ? ACCENT : SOFT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(cat.label, s[0], s[1] + d * z / 2 + 5);
    ctx.restore();
  }
}

function drawEquipment(editor) {
  for (const it of ensureEquipment(editor.level)) drawPlanSymbol(editor, it);

  if (editor.tool !== 'equipment' || !editor.mouse) return;
  const cat = EQUIPMENT_TYPES[state.type];
  if (!cat) return;
  const p = [snap(editor.mouse.w[0]), snap(editor.mouse.w[1])];
  const room = roomInfoAt(editor.level, p);
  const preview = {
    id: '__preview__',
    type: state.type,
    x: p[0],
    y: p[1],
    rotation: state.previewRotation,
    width: cat.width,
    depth: cat.depth,
    height: cat.height,
    zOffset: cat.zOffset || 0,
  };
  drawPlanSymbol(editor, preview, room ? 0.72 : 0.32, true);
}

function renderEquipmentInspector(editor) {
  const item = state.selectedId ? equipment(editor, state.selectedId) : null;
  if (!item) return;
  const cat = EQUIPMENT_TYPES[item.type] || EQUIPMENT_TYPES.baseCabinet;
  const room = roomForItem(editor.level, item);
  const root = document.querySelector('#inspector');
  if (!root) return;
  root.innerHTML = `
    <h2>${esc(cat.label)}</h2>
    <p class="sub">${room?.room ? `Dans : ${esc(room.room.name)}` : 'Équipement intérieur'}</p>
    <div class="grid2">
      ${equipNumberField('Largeur', 'width', item.width)}
      ${equipNumberField('Profondeur', 'depth', item.depth)}
    </div>
    <div class="grid2">
      ${equipNumberField('Hauteur', 'height', item.height)}
      ${equipNumberField('Hauteur au sol', 'zOffset', item.zOffset || 0)}
    </div>
    <label class="field">
      <span class="field-label">Rotation</span>
      <span class="unit" data-unit="°"><input type="text" inputmode="decimal" value="${fmt(item.rotation || 0, 0)}" data-equipment-prop="rotation" /></span>
    </label>
    <div class="row">
      <button class="btn" data-equipment-act="rotate-left">Pivoter à gauche</button>
      <button class="btn" data-equipment-act="rotate-right">Pivoter à droite</button>
    </div>
    <section>
      <button class="btn danger block" data-equipment-act="delete">Supprimer <kbd>Suppr</kbd></button>
    </section>`;
}

function equipNumberField(label, prop, value) {
  return `<label class="field"><span class="field-label">${esc(label)}</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(value)}" data-equipment-prop="${prop}" /></span></label>`;
}

function equipmentIcon(type) {
  const common = 'fill="none" stroke="#26323a" stroke-width="1.5"';
  const shapes = {
    wc: `<rect x="35" y="4" width="30" height="7" ${common}/><ellipse cx="50" cy="20" rx="14" ry="8" ${common}/>`,
    basin: `<rect x="20" y="5" width="60" height="20" ${common}/><ellipse cx="50" cy="15" rx="19" ry="7" ${common}/>`,
    shower: `<rect x="30" y="3" width="40" height="24" ${common}/><path d="M30 3 70 27M70 3 30 27" ${common}/>`,
    bath: `<rect x="10" y="5" width="80" height="20" rx="8" ${common}/><rect x="17" y="9" width="66" height="12" rx="6" ${common}/>`,
    sink: `<rect x="17" y="5" width="66" height="20" ${common}/><ellipse cx="50" cy="15" rx="20" ry="7" ${common}/>`,
    baseCabinet: `<rect x="20" y="5" width="60" height="20" ${common}/><path d="M50 5v20" ${common}/>`,
    wallCabinet: `<rect x="20" y="4" width="60" height="22" ${common}/><path d="M50 4v22M20 8h60" ${common}/>`,
    fridge: `<rect x="30" y="3" width="40" height="24" ${common}/><path d="M30 13h40" ${common}/>`,
    cooktop: `<rect x="20" y="4" width="60" height="22" ${common}/><circle cx="38" cy="11" r="5" ${common}/><circle cx="62" cy="11" r="5" ${common}/><circle cx="38" cy="21" r="5" ${common}/><circle cx="62" cy="21" r="5" ${common}/>`,
    worktop: `<rect x="8" y="8" width="84" height="14" ${common}/><path d="M30 8v14M70 8v14" ${common}/>`,
    vanity: `<rect x="20" y="5" width="60" height="20" ${common}/><ellipse cx="50" cy="14" rx="16" ry="6" ${common}/>`,
    washer: `<rect x="32" y="3" width="36" height="24" ${common}/><circle cx="50" cy="15" r="8" ${common}/>`,
    towelDryer: `<path d="M40 4v22M60 4v22M40 8h20M40 13h20M40 18h20M40 23h20" ${common}/>`,
    oven: `<rect x="30" y="3" width="40" height="24" ${common}/><rect x="35" y="10" width="30" height="13" ${common}/>`,
    dishwasher: `<rect x="30" y="3" width="40" height="24" ${common}/><path d="M34 8h32" ${common}/>`,
    hood: `<path d="M26 22h48l-8-8H34z M44 14V4h12v10" ${common}/>`,
    bedDouble: `<rect x="25" y="2" width="50" height="26" ${common}/><rect x="29" y="4" width="19" height="6" ${common}/><rect x="52" y="4" width="19" height="6" ${common}/><path d="M25 12h50" ${common}/>`,
    bedSingle: `<rect x="38" y="2" width="24" height="26" ${common}/><rect x="41" y="4" width="18" height="6" ${common}/><path d="M38 12h24" ${common}/>`,
    sofa: `<rect x="15" y="6" width="70" height="20" ${common}/><path d="M15 12h70M23 12v14M77 12v14" ${common}/>`,
    table: `<rect x="20" y="7" width="60" height="16" ${common}/>`,
    chair: `<rect x="40" y="7" width="20" height="18" ${common}/><path d="M40 10h20" ${common}/>`,
    desk: `<rect x="20" y="8" width="60" height="14" ${common}/><path d="M24 8v14M76 8v14" ${common}/>`,
    wardrobe: `<rect x="25" y="5" width="50" height="20" ${common}/><path d="M25 5l50 20M75 5 25 25" ${common}/>`,
    radiator: `<rect x="20" y="11" width="60" height="8" ${common}/><path d="M28 11v8M36 11v8M44 11v8M52 11v8M60 11v8M68 11v8" ${common}/>`,
  };
  return `<svg viewBox="0 0 100 30" aria-hidden="true">${shapes[type] || shapes.baseCabinet}</svg>`;
}

function stepHtml(editor) {
  const items = ensureEquipment(editor.level);
  return `
    <p>Choisissez un équipement puis cliquez dans une pièce pour le poser.</p>
    ${Object.entries(EQUIPMENT_GROUPS).map(([group, title]) => `
      <span class="field-label">${esc(title)}</span>
      <div class="grid2">
        ${Object.entries(EQUIPMENT_TYPES).filter(([, x]) => x.group === group).map(([k, x]) => `
          <button class="tile ${state.type === k && editor.tool === 'equipment' ? 'on' : ''}" data-equipment-type="${k}">
            ${equipmentIcon(k)}<span>${esc(x.label)}</span><small>${fmt(x.width)} × ${fmt(x.depth)} m</small>
          </button>`).join('')}
      </div>`).join('')}
    <ul class="keys">
      <li>Clic : poser l'équipement dans une pièce.</li>
      <li><kbd>R</kbd> : pivoter de 90° avant la pose.</li>
      <li><kbd>V</kbd> : revenir à la sélection pour déplacer un élément.</li>
      <li><kbd>Suppr</kbd> : supprimer l'élément sélectionné.</li>
    </ul>
    ${items.length ? `<p class="ok">${items.length} équipement${items.length > 1 ? 's' : ''} sur ce niveau.</p>` : ''}`;
}

function refreshStep() {
  if (state.refreshing) return;
  const editor = window.smelt?.editor;
  const root = document.querySelector('#steps');
  if (!editor || !root) return;

  state.refreshing = true;
  try {
    const roomHead = root.querySelector('.step-head[data-step="rooms"]');
    const roomStep = roomHead?.closest('.step');
    if (!roomStep) return;

    let custom = root.querySelector('[data-equipment-step-root]');
    if (!custom) {
      custom = document.createElement('div');
      custom.className = 'step';
      custom.dataset.equipmentStepRoot = '1';
      custom.innerHTML = `
        <button class="step-head" data-equipment-step="1" aria-expanded="false">
          <span class="step-num"></span>
          <span class="step-title">Équiper les pièces</span>
          <span class="step-check"></span>
        </button>
        <div class="step-body"></div>`;
      roomStep.insertAdjacentElement('afterend', custom);
    }

    const count = ensureEquipment(editor.level).length;
    custom.classList.toggle('done', count > 0);
    custom.querySelector('.step-check').textContent = count > 0 ? '✓' : '';

    if (state.active) {
      for (const step of root.querySelectorAll('.step')) if (step !== custom) step.classList.remove('active');
      custom.classList.add('active');
      custom.querySelector('[data-equipment-step]').setAttribute('aria-expanded', 'true');
      const html = stepHtml(editor);
      const body = custom.querySelector('.step-body');
      if (body.innerHTML !== html) body.innerHTML = html;
    } else {
      custom.classList.remove('active');
      custom.querySelector('[data-equipment-step]').setAttribute('aria-expanded', 'false');
      if (custom.querySelector('.step-body').innerHTML) custom.querySelector('.step-body').innerHTML = '';
    }

    [...root.querySelectorAll(':scope > .step')].forEach((step, i) => {
      const num = step.querySelector('.step-num');
      const value = String(i + 1);
      if (num && num.textContent !== value) num.textContent = value;
    });
  } finally {
    state.refreshing = false;
  }
}

function selectEquipment(editor, id) {
  state.selectedId = id;
  editor.selection = null;
  editor.invalidate();
  queueMicrotask(() => renderEquipmentInspector(editor));
}

function clearEquipmentSelection(editor) {
  if (!state.selectedId) return;
  state.selectedId = null;
  editor.invalidate();
}

function placeEquipment(editor, p) {
  const cat = EQUIPMENT_TYPES[state.type];
  if (!cat) return;
  const point = [snap(p[0]), snap(p[1])];
  const room = roomInfoAt(editor.level, point);
  if (!room?.room) {
    toast("Cliquez à l'intérieur d'une pièce fermée.", 'warn');
    return;
  }
  const id = M.uid('eq');
  const levelId = editor.levelId;
  editor.store.commit(`Poser : ${cat.label}`, (project) => {
    const level = project.levels.find((l) => l.id === levelId);
    ensureEquipment(level).push({
      id,
      type: state.type,
      x: point[0],
      y: point[1],
      rotation: state.previewRotation,
      width: cat.width,
      depth: cat.depth,
      height: cat.height,
      zOffset: cat.zOffset || 0,
      roomId: room.room.id,
    });
  });
  selectEquipment(editor, id);
}

function patchEditor(editor) {
  if (editor.__equipmentPatched) return;
  editor.__equipmentPatched = true;
  ensureEquipment(editor.level);

  const originalRender = editor.render.bind(editor);
  editor.render = function patchedRender() {
    const result = originalRender();
    ensureEquipment(this.level);
    drawEquipment(this);
    return result;
  };

  const originalHitTest = editor.hitTest.bind(editor);
  editor.hitTest = function patchedHitTest(p) {
    return equipmentHit(this, p) || originalHitTest(p);
  };

  const originalSelectDown = editor.selectDown.bind(editor);
  editor.selectDown = function patchedSelectDown(w, s) {
    const hit = equipmentHit(this, w);
    if (!hit) {
      clearEquipmentSelection(this);
      return originalSelectDown(w, s);
    }
    const it = equipment(this, hit.id);
    if (!it) return;
    selectEquipment(this, hit.id);
    this.store.beginGesture('Déplacer un équipement');
    this.drag = { kind: 'equipment', id: hit.id, start: w, x: it.x, y: it.y };
  };

  const originalDragMove = editor.dragMove.bind(editor);
  editor.dragMove = function patchedDragMove(w, s) {
    const d = this.drag;
    if (!d || d.kind !== 'equipment') return originalDragMove(w, s);
    if (G.dist(w, d.start) < this.px(3) && !d.moved) return;
    const p = [snap(d.x + w[0] - d.start[0]), snap(d.y + w[1] - d.start[1])];
    const room = roomInfoAt(this.level, p);
    if (!room?.room) return;
    d.moved = true;
    const levelId = this.levelId;
    this.store.live((project) => {
      const level = project.levels.find((l) => l.id === levelId);
      const item = ensureEquipment(level).find((x) => x.id === d.id);
      if (!item) return;
      item.x = p[0];
      item.y = p[1];
      item.roomId = room.room.id;
    });
  };

  const originalDeleteSelection = editor.deleteSelection.bind(editor);
  editor.deleteSelection = function patchedDeleteSelection() {
    if (!state.selectedId) return originalDeleteSelection();
    const id = state.selectedId;
    const levelId = this.levelId;
    this.store.commit('Équipement supprimé', (project) => {
      const level = project.levels.find((l) => l.id === levelId);
      level.equipment = ensureEquipment(level).filter((x) => x.id !== id);
    });
    state.selectedId = null;
    toast('Équipement supprimé');
    this.invalidate();
  };

  const originalOnDown = editor.onDown.bind(editor);
  editor.onDown = function patchedOnDown(e) {
    if (this.tool !== 'equipment' || e.button !== 0 || this.keys.space) return originalOnDown(e);
    const s = this.eventScreen(e);
    const w = this.toWorld(s);
    this.canvas.setPointerCapture(e.pointerId);
    placeEquipment(this, w);
  };

  const originalOnMove = editor.onMove.bind(editor);
  editor.onMove = function patchedOnMove(e) {
    const result = originalOnMove(e);
    if (this.tool === 'equipment') this.invalidate();
    return result;
  };

  const originalOnKey = editor.onKey.bind(editor);
  editor.onKey = function patchedOnKey(e, down) {
    if (down && !(e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) {
      const k = e.key.toLowerCase();
      if (this.tool === 'equipment' && k === 'r') {
        state.previewRotation = deg(state.previewRotation + 90);
        this.invalidate();
        refreshStep();
        e.preventDefault();
        return;
      }
      if (state.selectedId && k === 'r') {
        rotateSelected(this, 90);
        e.preventDefault();
        return;
      }
      if (state.selectedId && (e.key === 'Delete' || e.key === 'Backspace')) {
        this.deleteSelection();
        e.preventDefault();
        return;
      }
      if (this.tool === 'equipment' && e.key === 'Escape') {
        state.active = false;
        state.selectedId = null;
        refreshStep();
      }
    }
    return originalOnKey(e, down);
  };

  const originalSetTool = editor.setTool.bind(editor);
  editor.setTool = function patchedSetTool(tool, opts = {}) {
    const out = originalSetTool(tool, opts);
    this.canvas.style.cursor = tool === 'equipment' ? 'crosshair' : '';
    return out;
  };

  const originalStatus = editor.updateStatus.bind(editor);
  editor.updateStatus = function patchedStatus() {
    const out = originalStatus();
    if (this.tool === 'equipment') {
      const hint = document.querySelector('#statusHint');
      if (hint) hint.textContent = `Cliquez dans une pièce pour poser : ${EQUIPMENT_TYPES[state.type]?.label || 'équipement'}. R : pivoter.`;
    }
    return out;
  };

  if (!state.storeBound) {
    state.storeBound = true;
    editor.store.subscribe(() => {
      queueMicrotask(() => {
        refreshStep();
        if (state.selectedId && equipment(editor, state.selectedId)) renderEquipmentInspector(editor);
      });
    });
  }
}

function rotateSelected(editor, delta) {
  const id = state.selectedId;
  if (!id) return;
  const levelId = editor.levelId;
  editor.store.commit('Pivoter un équipement', (project) => {
    const level = project.levels.find((l) => l.id === levelId);
    const it = ensureEquipment(level).find((x) => x.id === id);
    if (it) it.rotation = deg((it.rotation || 0) + delta);
  });
  queueMicrotask(() => renderEquipmentInspector(editor));
}

function changeEquipmentProp(editor, prop, raw) {
  const id = state.selectedId;
  if (!id) return;
  const value = parseNum(raw);
  if (!Number.isFinite(value)) {
    toast('Valeur invalide.', 'warn');
    renderEquipmentInspector(editor);
    return;
  }
  if (['width', 'depth', 'height'].includes(prop) && value < 0.05) {
    toast('La dimension doit être positive.', 'warn');
    renderEquipmentInspector(editor);
    return;
  }
  if (prop === 'zOffset' && value < 0) {
    toast('La hauteur au sol ne peut pas être négative.', 'warn');
    renderEquipmentInspector(editor);
    return;
  }
  const levelId = editor.levelId;
  editor.store.commit('Modifier un équipement', (project) => {
    const level = project.levels.find((l) => l.id === levelId);
    const it = ensureEquipment(level).find((x) => x.id === id);
    if (!it) return;
    if (prop === 'rotation') it.rotation = deg(value);
    else it[prop] = value;
  });
  queueMicrotask(() => renderEquipmentInspector(editor));
}


const equipmentAssetLoader = new GLTFLoader();
const equipmentAssetPromises = new Map();
const equipmentAssets = new Map();

function loadEquipmentAsset(type) {
  const cat = EQUIPMENT_TYPES[type];
  if (!cat?.asset) return Promise.resolve(null);
  if (equipmentAssets.has(type)) return Promise.resolve(equipmentAssets.get(type));
  if (equipmentAssetPromises.has(type)) return equipmentAssetPromises.get(type);

  const promise = equipmentAssetLoader.loadAsync(cat.asset)
    .then((gltf) => {
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      if (![size.x, size.y, size.z].every((v) => Number.isFinite(v) && v > 1e-6)) {
        throw new Error(`Dimensions invalides pour ${cat.asset}`);
      }
      const asset = { scene, box, size, center };
      // Le catalogue n'est plus modifié au chargement : les dimensions par défaut restent
      // celles du catalogue, quel que soit le moment où le fichier finit de charger.
      equipmentAssets.set(type, asset);
      return asset;
    })
    .catch((err) => {
      console.warn(`Équipement GLB impossible à charger (${cat.asset})`, err);
      return null;
    });

  equipmentAssetPromises.set(type, promise);
  return promise;
}

async function preloadEquipmentAssets() {
  const types = Object.keys(EQUIPMENT_TYPES).filter((type) => EQUIPMENT_TYPES[type].asset);
  await Promise.all(types.map(loadEquipmentAsset));
}

function assetEquipmentObject(project, level, item, asset) {
  const cat = EQUIPMENT_TYPES[item.type] || EQUIPMENT_TYPES.baseCabinet;
  const group = new THREE.Group();
  group.name = cat.label;
  group.userData = {
    smeltKey: `equipment-${item.id}`,
    ifcType: cat.ifcClass === 'IFCSANITARYTERMINAL' ? 'IfcSanitaryTerminal' : 'IfcFurniture',
    smeltSource: 'Smelt Studio',
    level: level.name,
    equipmentType: item.type,
    asset: cat.asset,
  };

  // On clone le GLB, puis on neutralise son origine Blender :
  // centre de l'emprise en X/Z et point le plus bas posé à Y=0.
  const model = asset.scene.clone(true);
  model.updateMatrixWorld(true);

  const visual = new THREE.Group();
  visual.add(model);
  model.position.x -= asset.center.x;
  model.position.y -= asset.box.min.y;
  model.position.z -= asset.center.z;

  // Les dimensions enregistrées dans Smelt restent éditables.
  // Le modèle est mis à l'échelle par rapport à sa boîte englobante native.
  const sx = item.width / asset.size.x;
  const sy = item.height / asset.size.y;
  const sz = item.depth / asset.size.z;
  visual.scale.set(sx, sy, sz);
  visual.position.y = item.zOffset || 0;

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
  });

  group.add(visual);
  group.position.set(item.x, floorZ(project, level, item), item.y);
  group.rotation.y = -(item.rotation || 0) * Math.PI / 180;
  return group;
}

const materialCache = new Map();
function equipmentMaterial(key) {
  if (materialCache.has(key)) return materialCache.get(key);
  const spec = EQUIPMENT_MATERIALS[key] || EQUIPMENT_MATERIALS.cabinet;
  const m = new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness ?? 0.6,
    metalness: spec.metalness ?? 0,
    transparent: (spec.opacity ?? 1) < 1,
    opacity: spec.opacity ?? 1,
    depthWrite: (spec.opacity ?? 1) >= 1,
    side: THREE.DoubleSide,
  });
  m.name = key;
  materialCache.set(key, m);
  return m;
}

// plan (x, y vers le bas, z haut) → three (x, y haut, z), géométrie indexée
function planMeshToGeometry(mesh) {
  const pos = new Float32Array(mesh.triangles.length * 9);
  let k = 0;
  for (const tri of mesh.triangles) {
    for (const idx of [tri[0], tri[2], tri[1]]) {
      const p = mesh.positions[idx];
      pos[k++] = p[0]; pos[k++] = p[2]; pos[k++] = p[1];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const count = pos.length / 3;
  const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

function ifcTypeOf(cat) {
  if (cat.ifcClass === 'IFCSANITARYTERMINAL') return 'IfcSanitaryTerminal';
  if (cat.ifcClass === 'IFCELECTRICAPPLIANCE') return 'IfcElectricAppliance';
  return 'IfcFurniture';
}

function generatedEquipmentObject(project, level, item) {
  const cat = EQUIPMENT_TYPES[item.type] || EQUIPMENT_TYPES.baseCabinet;
  const group = new THREE.Group();
  group.name = cat.label;
  group.userData = {
    smeltKey: `equipment-${item.id}`,
    ifcType: ifcTypeOf(cat),
    smeltSource: 'Smelt Studio',
    level: level.name,
    equipmentType: item.type,
  };
  const parts = placeParts(item, equipmentParts({ ...item, model: cat.model }), floorZ(project, level, item));
  for (const p of parts) {
    const mesh = new THREE.Mesh(planMeshToGeometry(p.mesh), equipmentMaterial(p.mat));
    mesh.name = cat.label;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { smeltIfcType: ifcTypeOf(cat), ifcType: ifcTypeOf(cat), smeltSource: 'Smelt Studio', level: level.name, equipmentType: item.type };
    group.add(mesh);
  }
  return group;
}

function equipmentObject(project, level, item) {
  const cat = EQUIPMENT_TYPES[item.type];
  const asset = cat?.asset ? equipmentAssets.get(item.type) : null;
  if (asset) return assetEquipmentObject(project, level, item, asset);
  return generatedEquipmentObject(project, level, item);
}

function addEquipment3D(root, project) {
  for (const level of project.levels) {
    for (const item of ensureEquipment(level)) root.add(equipmentObject(project, level, item));
  }
}

function patchView3D() {
  if (View3D.prototype.__equipmentPatched) return;
  View3D.prototype.__equipmentPatched = true;
  const original = View3D.prototype.update;
  View3D.prototype.update = function patchedUpdate(project, options = {}) {
    this.__equipmentProject = project;
    this.__equipmentOptions = options;
    const warnings = original.call(this, project, options);
    if (this.model) {
      addEquipment3D(this.model, project);
      this.requestRender();
    }
    return warnings;
  };
}

function safeName(name) {
  return (name || 'projet')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '')
    .toLowerCase() || 'projet';
}

function download(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportGlbNow() {
  const project = window.smelt.store.project;
  await preloadEquipmentAssets();
  const { root } = buildObject3D(project, { edges: false });
  addEquipment3D(root, project);
  const exporter = new GLTFExporter();
  const blob = await new Promise((resolve, reject) => {
    exporter.parse(root, (result) => resolve(new Blob([result], { type: 'model/gltf-binary' })), reject, { binary: true });
  });
  download(`${safeName(project.name)}.glb`, blob, 'model/gltf-binary');
  toast('GLB exporté avec les équipements.');
}

async function exportIfcNow() {
  const smelt = window.smelt;
  const project = smelt.store.project;

  await preloadEquipmentAssets();

  const missing = [];
  for (const level of project.levels || []) {
    for (const item of ensureEquipment(level)) {
      const cat = EQUIPMENT_TYPES[item.type];
      if (cat?.asset && !equipmentAssets.has(item.type)) missing.push(cat.label);
    }
  }

  if (missing.length) {
    throw new Error(`GLB non chargé : ${[...new Set(missing)].join(', ')}`);
  }

  // Important : aucun post-traitement du STEP ici.
  // On appelle directement l'exporteur IFC natif, qui lit les meshes GLB
  // préchargés et produit des IfcTriangulatedFaceSet.
  const text = smelt.exportIfc();
  download(`${safeName(project.name)}.ifc`, text, 'application/x-step');
  toast('IFC exporté avec les équipements.');
}

function bindUi(editor) {
  document.addEventListener('click', (e) => {
    const equipmentStep = e.target.closest('[data-equipment-step]');
    if (equipmentStep) {
      e.preventDefault();
      e.stopPropagation();
      state.active = true;
      editor.setTool('equipment', { equipmentType: state.type });
      refreshStep();
      return;
    }

    const equipmentType = e.target.closest('[data-equipment-type]');
    if (equipmentType) {
      e.preventDefault();
      e.stopPropagation();
      state.type = equipmentType.dataset.equipmentType;
      state.active = true;
      editor.setTool('equipment', { equipmentType: state.type });
      refreshStep();
      editor.invalidate();
      return;
    }

    const action = e.target.closest('[data-equipment-act]');
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      const act = action.dataset.equipmentAct;
      if (act === 'rotate-left') rotateSelected(editor, -90);
      if (act === 'rotate-right') rotateSelected(editor, 90);
      if (act === 'delete') editor.deleteSelection();
      return;
    }

    if (e.target.closest('[data-step], #toolbar [data-tool]')) {
      state.active = false;
      refreshStep();
    }
  }, true);

  document.addEventListener('change', (e) => {
    const prop = e.target.dataset?.equipmentProp;
    if (!prop) return;
    e.stopPropagation();
    changeEquipmentProp(editor, prop, e.target.value);
  }, true);

  // Les exports sont interceptés uniquement lorsqu'il y a des équipements.
  // Pour l'IFC, l'interception sert seulement à attendre le chargement des GLB.
  // La génération du STEP reste faite par l'exporteur natif Smelt.
  document.addEventListener('click', (e) => {
    const ifcTarget = e.target.closest('[data-act="export-ifc"]');
    const glbTarget = e.target.closest('[data-act="export-glb"]');
    if (!ifcTarget && !glbTarget) return;

    const project = window.smelt?.store?.project;
    if (!project?.levels?.some((l) => ensureEquipment(l).length)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const action = ifcTarget ? exportIfcNow : exportGlbNow;
    action().catch((err) => {
      console.error(err);
      toast(`Export ${ifcTarget ? 'IFC' : 'GLB'} impossible : ${err.message}`, 'warn');
    });
  }, true);

  // Le panneau natif reconstruit parfois entièrement #steps avec innerHTML.
  // On n'observe QUE les enfants directs de #steps : observer tout le sous-arbre
  // ferait réagir le plugin à ses propres mises à jour et créerait une boucle de rendu.
  const steps = document.querySelector('#steps');
  if (steps) {
    const observer = new MutationObserver(() => {
      // L'insertion de notre propre étape déclenche aussi l'observer une fois.
      // Si elle existe déjà, aucune reconstruction n'est nécessaire.
      if (!steps.querySelector('[data-equipment-step-root]')) refreshStep();
    });
    observer.observe(steps, { childList: true });
  }

  refreshStep();
}

function init() {
  const smelt = window.smelt;
  if (!smelt?.editor || !smelt?.store) {
    setTimeout(init, 0);
    return;
  }
  patchView3D();
  patchEditor(smelt.editor);
  bindUi(smelt.editor);
  smelt.editor.invalidate();

  // Petits helpers utiles en console pour le debug, sans modifier l'API existante.
  smelt.equipment = {
    types: EQUIPMENT_TYPES,
    assets: equipmentAssets,
    reloadAssets: preloadEquipmentAssets,
  };

  preloadEquipmentAssets().then(() => {
    const view = smelt.view3d;
    if (view?.__equipmentProject) {
      view.update(view.__equipmentProject, view.__equipmentOptions || {});
    }
  });
}

init();
