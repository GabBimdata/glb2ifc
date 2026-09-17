// Smelt Studio — point d'entrée de l'interface.
import * as M from './model.js';
import * as G from './geometry.js';
import { WALL_TYPES, OPENING_TYPES, ROOM_NAMES, ROOF_TYPES } from './catalog.js';
import { Editor2D } from './editor2d.js';
import { View3D, exportGlb } from './view3d.js';
import { exportIfc } from './ifc-export.js';
import * as IO from './io.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => Number(v).toFixed(d).replace('.', ',');
const parseNum = (v) => parseFloat(String(v).replace(',', '.'));

const store = new M.Store(M.newProject('Ma maison'));
const ui = { step: 'plan', viewMode: 'plan', scope: 'all', exported: false };

// ─── Notifications et fenêtres ────────────────────────────────────────────────

function toast(message, kind = '') {
  if (!message) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'warn' ? 4200 : 2600);
}

function modal({ title, body, actions, wide = false, onMount }) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-back">
        <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <header><h3>${esc(title)}</h3></header>
          <div class="content">${body}</div>
          <footer>${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</footer>
        </div>
      </div>`;
    const back = root.firstElementChild;
    const close = (value) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(value); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        const def = actions.findIndex((a) => a.default);
        if (def >= 0) back.querySelector(`[data-i="${def}"]`).click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('click', (e) => {
      if (e.target === back) return close(null);
      const btn = e.target.closest('[data-i]');
      if (!btn) return;
      const action = actions[+btn.dataset.i];
      const value = action.value ? action.value(back) : action.id;
      if (value === undefined) return; // validation refusée
      close(value);
    });
    onMount?.(back, close);
    const first = back.querySelector('input, select');
    (first || back.querySelector('.btn.primary'))?.focus();
  });
}

function busy(text) {
  const el = document.createElement('div');
  el.className = 'busy';
  el.textContent = text;
  document.body.appendChild(el);
  return () => el.remove();
}

// ─── Éditeur et vue 3D ────────────────────────────────────────────────────────

const editor = new Editor2D($('#plan'), store, {
  onSelect: () => renderInspector(),
  onToast: toast,
  onStatus: (s) => {
    $('#statusHint').textContent = s.hint || '';
    $('#statusSnap').textContent = s.snap ? `Aimant : ${s.snap}` : '';
    $('#statusCoords').textContent = s.coords;
    $('#statusZoom').textContent = `1 m = ${Math.round(s.zoom)} px`;
  },
  onToolChange: (tool) => {
    for (const b of document.querySelectorAll('#toolbar button')) b.classList.toggle('on', b.dataset.tool === tool);
  },
  requestTool: (tool) => setTool(tool),
  onTyped: (value) => {
    const el = $('#typed');
    if (!value) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.textContent = `${value.replace('.', ',')} m`;
    const m = editor.mouse?.s || [editor.w / 2, editor.h / 2];
    el.style.left = `${m[0] + 16}px`;
    el.style.top = `${m[1] - 30}px`;
  },
  requestScaleDistance: async (measured) => {
    const plan = editor.level.plan;
    const hint = plan?.calibrated ? `Avec l'échelle actuelle, ce segment mesure ${fmt(measured)} m.` : 'Indiquez la longueur réelle, lue sur une cote du plan.';
    return modal({
      title: 'Longueur réelle de ce segment',
      body: `<p>${hint}</p><label class="field"><span class="field-label">Distance réelle</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" id="realDist" placeholder="par exemple 8,45" /></span></label>`,
      actions: [
        { label: 'Annuler', id: null },
        {
          label: "Appliquer l'échelle", kind: 'primary', default: true,
          value: (root) => {
            const v = parseNum(root.querySelector('#realDist').value);
            if (!(v > 0)) { root.querySelector('#realDist').style.borderColor = 'var(--danger)'; return undefined; }
            return v;
          },
        },
      ],
    });
  },
});

let view3d = null;
function ensure3D() {
  if (!view3d) view3d = new View3D($('#viewPane'));
  return view3d;
}

let rebuildTimer = null;
function schedule3D(immediate = false) {
  if (ui.viewMode === 'plan') return;
  clearTimeout(rebuildTimer);
  const run = () => {
    const v = ensure3D();
    const sel = editor.selection;
    let selectedKey = null;
    if (sel?.type === 'wall') selectedKey = `wall-${sel.id}`;
    if (sel?.type === 'opening') selectedKey = `op-${sel.id}`;
    const warnings = v.update(store.project, {
      upToLevelIndex: ui.scope === 'all' ? undefined : editor.levelIndex,
      selectedKey,
    });
    ui.roofWarning = warnings[0] || null;
  };
  if (immediate) run(); else rebuildTimer = setTimeout(run, 120);
}

function setViewMode(mode) {
  ui.viewMode = mode;
  $('#stage').dataset.mode = mode;
  for (const b of document.querySelectorAll('#viewMode button')) b.classList.toggle('on', b.dataset.mode === mode);
  requestAnimationFrame(() => {
    editor.resize();
    if (mode !== '3d') editor.fit();
    if (mode !== 'plan') {
      const v = ensure3D();
      v.resize();
      schedule3D(true);
      v.frame();
    }
  });
}

function setTool(tool, opts) {
  editor.setTool(tool, opts);
  renderSteps();
}

// ─── Parcours (colonne de gauche) ─────────────────────────────────────────────

const STEPS = [
  { id: 'plan', title: 'Importer le plan', tool: 'select' },
  { id: 'scale', title: "Mettre à l'échelle", tool: null },
  { id: 'walls', title: 'Tracer les murs', tool: 'wall' },
  { id: 'openings', title: 'Poser portes et fenêtres', tool: 'opening' },
  { id: 'rooms', title: 'Nommer les pièces', tool: 'select' },
  { id: 'levels', title: 'Gérer les étages', tool: 'select' },
  { id: 'roof', title: 'Couvrir', tool: 'select' },
  { id: 'export', title: 'Exporter', tool: 'select' },
];

function stepDone(id) {
  const p = store.project;
  const L = editor.level;
  switch (id) {
    case 'plan': return !!L.plan;
    case 'scale': return !!L.plan?.calibrated;
    case 'walls': return L.walls.length > 0;
    case 'openings': return L.walls.some((w) => w.openings.length);
    case 'rooms': return L.rooms.length > 0 && L.rooms.every((r) => !/^Pièce \d+$/.test(r.name));
    case 'levels': return p.levels.length > 1;
    case 'roof': return p.roof.enabled && p.levels[p.levels.length - 1].walls.length > 0;
    case 'export': return ui.exported;
    default: return false;
  }
}

function goStep(id) {
  ui.step = id;
  const step = STEPS.find((s) => s.id === id);
  if (id === 'scale') {
    const plan = editor.level.plan;
    setTool(plan && !plan.calibrated ? 'scale' : 'measure');
  } else if (step.tool) {
    setTool(step.tool);
  }
  if (id === 'roof' && ui.viewMode === 'plan') setViewMode('split');
  renderSteps();
}

const wallSwatch = (type) => {
  const t = WALL_TYPES[type];
  const h = Math.max(3, Math.round(t.thickness * 34));
  const color = t.category === 'exterior' ? '#26323a' : t.category === 'interior' ? '#4a565d' : '#8a959b';
  return `<span class="swatch" style="height:${h}px;background:${color}"></span>`;
};

const openingIcon = (key) => {
  const o = OPENING_TYPES[key];
  const w = 20 + o.width * 22;
  const x0 = (100 - w) / 2;
  if (o.kind === 'door') {
    return `<svg viewBox="0 0 100 30" aria-hidden="true"><path d="M0 26H${x0}M${x0 + w} 26H100" stroke="#26323a" stroke-width="5"/><path d="M${x0} 24V${24 - Math.min(22, w)}" stroke="#1f2a30" stroke-width="1.5"/><path d="M${x0} ${24 - Math.min(22, w)}A${Math.min(22, w)} ${Math.min(22, w)} 0 0 1 ${x0 + Math.min(22, w)} 24" fill="none" stroke="#1f2a30" stroke-dasharray="2 2"/></svg>`;
  }
  return `<svg viewBox="0 0 100 30" aria-hidden="true"><path d="M0 22H${x0}M${x0 + w} 22H100" stroke="#26323a" stroke-width="7"/><path d="M${x0} 20H${x0 + w}M${x0} 24H${x0 + w}" stroke="#3f7fa0" stroke-width="1.4"/>${o.sill === 0 ? `<path d="M${x0} 22H${x0 + w}" stroke="#3f7fa0"/>` : ''}</svg>`;
};

function stepBody(id) {
  const p = store.project;
  const L = editor.level;
  const plan = L.plan;
  switch (id) {
    case 'plan':
      return `
        <p>Une image (PNG, JPG) ou un PDF par étage. Le plan sert de calque : il n'est pas exporté.</p>
        <div class="row"><button class="btn primary" data-act="import-plan">${plan ? 'Remplacer le plan' : 'Importer un plan'}</button>
        ${plan ? '<button class="btn ghost danger" data-act="remove-plan">Retirer</button>' : ''}</div>
        ${plan ? `<label class="field"><span class="field-label">Visibilité du plan</span><input type="range" min="0.1" max="1" step="0.05" value="${plan.opacity ?? 0.55}" data-live="plan-opacity" /></label>` : ''}
        <p>Pas de plan ? Passez directement à l'étape 3 et tracez sur la grille.</p>`;
    case 'scale': {
      if (!plan) return '<p>Aucun plan sur ce niveau : pas besoin d\'échelle. Vous pouvez tracer directement.</p>';
      const pdf = plan.ptPerPx
        ? `<label class="field"><span class="field-label">Échelle indiquée sur le PDF</span>
            <div class="inline"><span>1 /</span><input type="text" inputmode="numeric" placeholder="100" data-field="pdf-ratio" style="width:90px" /><button class="btn" data-act="apply-ratio">Appliquer</button></div></label>` : '';
      const below = editor.levelBelow;
      return `
        ${plan.calibrated ? '<p class="ok">Échelle réglée. Vérifiez sur une deuxième cote avec l\'outil Mesurer.</p>' : '<p class="note">Indispensable avant de tracer : sans échelle, les murs n\'auront pas les bonnes dimensions.</p>'}
        <p>Cliquez les deux extrémités d'une cote connue, puis saisissez sa longueur réelle. Plus la cote est longue, plus l'échelle est précise.</p>
        <div class="row">
          <button class="btn ${plan.calibrated ? '' : 'primary'}" data-act="tool-scale">${plan.calibrated ? "Refaire l'échelle" : 'Mesurer une cote'}</button>
          <button class="btn" data-act="tool-measure">Vérifier une cote</button>
        </div>
        ${pdf}
        ${below ? `<section style="margin-top:14px"><span class="field-label">Superposer à l'étage inférieur</span>
          <p>Cliquez un repère sur ce plan, puis le même point sur l'étage du dessous (affiché en gris).</p>
          <div class="row"><button class="btn" data-act="tool-calage">Caler par un point</button><button class="btn ghost" data-act="tool-move-plan">Déplacer à la main</button></div></section>` : ''}
        <div class="row" style="margin-top:6px"><button class="btn ghost" data-act="rotate-plan" data-deg="-90">Pivoter à gauche</button><button class="btn ghost" data-act="rotate-plan" data-deg="90">Pivoter à droite</button></div>`;
    }
    case 'walls': {
      if (plan && !plan.calibrated) {
        return `<p class="note">Réglez d'abord l'échelle du plan (étape 2).</p><button class="btn primary" data-go="scale">Aller à l'échelle</button>`;
      }
      return `
        <div class="choices">${Object.entries(WALL_TYPES).map(([k, t]) => `
          <button class="choice ${editor.wallType === k ? 'on' : ''}" data-wall-type="${k}"><span>${esc(t.label)}</span>${wallSwatch(k)}</button>`).join('')}
        </div>
        <span class="field-label">Le tracé suit</span>
        <div class="seg" style="margin-bottom:10px">
          <button class="${editor.traceMode === 'axis' ? 'on' : ''}" data-trace="axis">le milieu du mur</button>
          <button class="${editor.traceMode === 'edge' ? 'on' : ''}" data-trace="edge">un bord du mur</button>
        </div>
        ${editor.traceMode === 'edge' ? '<p>Le mur se place d\'un côté du tracé. Appuyez sur <kbd>F</kbd> pour changer de côté.</p>' : ''}
        <ul class="keys">
          <li>Clic : poser un point. Les pièces fermées apparaissent seules.</li>
          <li>Tapez <kbd>4,35</kbd> puis <kbd>Entrée</kbd> : longueur exacte</li>
          <li><kbd>Maj</kbd> : angle libre (sinon pas de 45°)</li>
          <li><kbd>Échap</kbd>, double-clic ou clic droit : terminer</li>
        </ul>`;
    }
    case 'openings':
      return `
        <div class="grid2">${Object.entries(OPENING_TYPES).map(([k, o]) => `
          <button class="tile ${editor.openingType === k ? 'on' : ''}" data-opening="${k}">${openingIcon(k)}<span>${esc(o.label)}</span><small>${fmt(o.width)} × ${fmt(o.height)} m</small></button>`).join('')}
        </div>
        <p>Survolez un mur : les distances aux angles s'affichent. Cliquez pour poser. Dimensions modifiables ensuite à droite.</p>`;
    case 'rooms': {
      const { rooms } = M.levelFaces(L);
      const list = rooms.filter((r) => r.room);
      if (!list.length) return '<p>Aucune pièce fermée sur ce niveau. Une pièce apparaît dès que ses murs forment un contour fermé.</p>';
      const total = list.reduce((s, r) => s + r.area, 0);
      const sel = editor.selection?.type === 'room' ? editor.selection.id : null;
      return `
        <p>Cliquez une pièce (ici ou sur le plan) pour la renommer.</p>
        <table class="table"><tbody>${list.map((r) => `<tr data-room="${r.room.id}" class="${sel === r.room.id ? 'sel' : ''}"><td>${esc(r.room.name)}</td><td>${fmt(r.area, 1)} m²</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total ${esc(L.name)}</td><td>${fmt(total, 1)} m²</td></tr></tfoot></table>`;
    }
    case 'levels':
      return `
        <table class="table"><tbody>${p.levels.map((l, i) => `<tr data-level="${l.id}" class="${l.id === L.id ? 'sel' : ''}"><td>${esc(l.name)}</td><td>+${fmt(M.levelElevation(p, l.id))} m</td></tr>`).slice().reverse().join('')}</tbody></table>
        <label class="field"><span class="field-label">Hauteur d'étage de « ${esc(L.name)} » (sol à sol)</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(L.height)}" data-field="level-height" /></span></label>
        <label class="field"><span class="field-label">Épaisseur des planchers</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(p.settings.slabThickness)}" data-field="slab" /></span></label>
        <div class="row">
          <button class="btn primary" data-act="dup-level">Dupliquer « ${esc(L.name)} »</button>
          <button class="btn" data-act="add-level">Niveau vide</button>
        </div>
        ${p.levels.length > 1 ? `<button class="btn ghost danger" data-act="del-level">Supprimer « ${esc(L.name)} »</button>` : ''}`;
    case 'roof': {
      const r = p.roof;
      const top = p.levels[p.levels.length - 1];
      return `
        <label class="check"><input type="checkbox" data-field="roof-enabled" ${r.enabled ? 'checked' : ''} /> Générer une toiture</label>
        <p>Elle se pose sur le contour du dernier niveau (${esc(top.name)}).</p>
        <div class="grid2">${Object.entries(ROOF_TYPES).map(([k, label]) => `<button class="tile ${r.type === k ? 'on' : ''}" data-roof="${k}">${roofIcon(k)}<span>${label}</span></button>`).join('')}</div>
        ${r.type !== 'flat' ? `<label class="field"><span class="field-label">Pente : ${Math.round(r.pitch)}°</span><input type="range" min="5" max="60" step="1" value="${r.pitch}" data-live="roof-pitch" /></label>` : ''}
        <div class="grid2">
          <label><span class="field-label">Débord</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(r.overhang)}" data-field="roof-overhang" /></span></label>
          <label><span class="field-label">Épaisseur</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(r.thickness)}" data-field="roof-thickness" /></span></label>
        </div>
        ${ui.roofWarning ? `<p class="note">${esc(ui.roofWarning)}</p>` : ''}`;
    }
    case 'export':
      return `
        <p>L'IFC contient les murs, planchers, pièces, portes, fenêtres et la toiture, avec leurs propriétés.</p>
        <div class="choices">
          <button class="btn primary block" data-act="export-ifc">Télécharger l'IFC</button>
          <button class="btn block" data-act="export-glb">Télécharger le GLB</button>
          <a class="btn ghost block" href="/viewer.html" target="_blank" rel="noopener">Ouvrir la visionneuse IFC</a>
        </div>
        <span class="field-label">Projet</span>
        <div class="choices">
          <button class="btn block" data-act="save-project">Enregistrer le projet (.smelt.json)</button>
          <button class="btn block" data-act="open-project">Ouvrir un projet</button>
          <button class="btn ghost block danger" data-act="new-project">Nouveau projet</button>
        </div>
        <p>Le travail est aussi sauvegardé automatiquement dans ce navigateur.</p>`;
    default: return '';
  }
}

function roofIcon(type) {
  const paths = {
    gable: 'M10 26 50 6 90 26',
    hip: 'M10 26 35 8H65L90 26',
    shed: 'M10 26 90 10',
    flat: 'M10 14H90',
  };
  return `<svg viewBox="0 0 100 30" aria-hidden="true"><path d="${paths[type]}" fill="none" stroke="#9b5a43" stroke-width="3" stroke-linejoin="round"/><path d="M18 28V${type === 'flat' ? 16 : 22}M82 28V${type === 'flat' ? 16 : type === 'shed' ? 14 : 22}" stroke="#26323a" stroke-width="3"/></svg>`;
}

function renderSteps() {
  const container = $('#steps');
  const focused = document.activeElement;
  if (focused && container.contains(focused) && focused.matches('input')) return; // ne pas perturber une saisie
  container.innerHTML = STEPS.map((s, i) => {
    const done = stepDone(s.id);
    const active = ui.step === s.id;
    return `<div class="step ${active ? 'active' : ''} ${done ? 'done' : ''}">
      <button class="step-head" data-step="${s.id}" aria-expanded="${active}">
        <span class="step-num">${i + 1}</span><span class="step-title">${s.title}</span><span class="step-check">${done ? '✓' : ''}</span>
      </button>
      <div class="step-body">${active ? stepBody(s.id) : ''}</div>
    </div>`;
  }).join('');
  renderCartouche();
}

function renderCartouche() {
  const p = store.project;
  let total = 0;
  for (const l of p.levels) total += M.levelFaces(l).rooms.reduce((s, r) => s + (r.room ? r.area : 0), 0);
  const L = editor.level;
  const scale = !L.plan ? 'sans plan' : L.plan.calibrated ? 'réglée' : 'à régler';
  $('#cartouche').innerHTML = `
    <div class="wide"><span>Projet</span><b>${esc(p.name)}</b></div>
    <div><span>Niveaux</span><b>${p.levels.length}</b></div>
    <div><span>Surface des pièces</span><b>${fmt(total, 1)} m²</b></div>
    <div><span>Niveau affiché</span><b>${esc(L.name)}</b></div>
    <div><span>Échelle du plan</span><b>${scale}</b></div>`;
}

// ─── Inspecteur (colonne de droite) ───────────────────────────────────────────

function findSelection() {
  const sel = editor.selection;
  if (!sel) return null;
  const L = editor.level;
  if (sel.type === 'wall') {
    const wall = L.walls.find((w) => w.id === sel.id);
    return wall ? { ...sel, wall } : null;
  }
  if (sel.type === 'opening') {
    const wall = L.walls.find((w) => w.id === sel.wallId);
    const opening = wall?.openings.find((o) => o.id === sel.id);
    return opening ? { ...sel, wall, opening } : null;
  }
  if (sel.type === 'node') return L.nodes[sel.id] ? { ...sel, point: L.nodes[sel.id] } : null;
  if (sel.type === 'room') {
    const room = L.rooms.find((r) => r.id === sel.id);
    if (!room) return null;
    const face = M.levelFaces(L).rooms.find((r) => r.room?.id === room.id);
    return { ...sel, room, area: face?.area || 0 };
  }
  return null;
}

const numField = (label, field, value, unit = 'm') => `
  <label class="field"><span class="field-label">${label}</span><span class="unit" data-unit="${unit}"><input type="text" inputmode="decimal" value="${fmt(value)}" data-prop="${field}" /></span></label>`;

function renderInspector() {
  const el = $('#inspector');
  if (el.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const s = findSelection();
  if (!s && editor.selection) editor.selection = null;
  const L = editor.level;
  const p = store.project;
  if (!s) {
    const { rooms } = M.levelFaces(L);
    const openings = L.walls.reduce((n, w) => n + w.openings.length, 0);
    const area = rooms.reduce((sum, r) => sum + (r.room ? r.area : 0), 0);
    el.innerHTML = `
      <h2>${esc(L.name)}</h2>
      <p class="sub">Altitude +${fmt(M.levelElevation(p, L.id))} m, hauteur ${fmt(L.height)} m</p>
      <div class="stat"><span>Murs</span><b>${L.walls.length}</b></div>
      <div class="stat"><span>Ouvertures</span><b>${openings}</b></div>
      <div class="stat"><span>Pièces</span><b>${rooms.length}</b></div>
      <div class="stat"><span>Surface des pièces</span><b>${fmt(area, 1)} m²</b></div>
      <section><p class="sub">Sélectionnez un mur, un angle, une ouverture ou une pièce sur le plan pour modifier ses valeurs.</p></section>`;
    return;
  }
  if (s.type === 'wall') {
    const w = s.wall;
    const a = L.nodes[w.a], b = L.nodes[w.b];
    el.innerHTML = `
      <h2>Mur</h2><p class="sub">${esc(WALL_TYPES[w.type]?.label || '')}</p>
      <label class="field"><span class="field-label">Type</span><select data-prop="wall-type">${Object.entries(WALL_TYPES).map(([k, t]) => `<option value="${k}" ${k === w.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
      ${numField('Longueur (axe)', 'wall-length', G.dist(a, b))}
      ${numField('Épaisseur', 'wall-thickness', w.thickness)}
      <p class="sub">Hauteur : ${fmt(M.wallHeight(p, L))} m (réglée par l'étage)</p>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer le mur <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'opening') {
    const o = s.opening;
    const cat = OPENING_TYPES[o.type];
    el.innerHTML = `
      <h2>${esc(cat?.label || (o.kind === 'door' ? 'Porte' : 'Fenêtre'))}</h2><p class="sub">Posée dans : ${esc(WALL_TYPES[s.wall.type]?.label || 'mur')}</p>
      <div class="grid2">
        ${numField('Largeur', 'op-width', o.width)}
        ${numField('Hauteur', 'op-height', o.height)}
      </div>
      <div class="grid2">
        ${numField('Allège', 'op-sill', o.sill)}
        ${numField('Position', 'op-offset', o.offset - o.width / 2)}
      </div>
      <p class="sub">Position : distance entre le début du mur et le bord de l'ouverture.</p>
      ${o.kind === 'door' ? '<div class="row"><button class="btn" data-act="op-flip-side">Inverser le côté</button><button class="btn" data-act="op-flip-hinge">Inverser le sens</button></div>' : ''}
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'node') {
    el.innerHTML = `
      <h2>Angle</h2><p class="sub">Point de jonction des murs</p>
      <div class="grid2">${numField('X', 'node-x', s.point[0])}${numField('Y', 'node-y', -s.point[1])}</div>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer l'angle et ses murs</button></section>`;
  } else if (s.type === 'room') {
    el.innerHTML = `
      <h2>Pièce</h2><p class="sub">${fmt(s.area, 1)} m² habitables (hors murs)</p>
      <label class="field"><span class="field-label">Nom</span><input type="text" value="${esc(s.room.name)}" data-prop="room-name" /></label>
      <div class="chips">${ROOM_NAMES.map((n) => `<button class="chip" data-room-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
  }
}

function applyProp(prop, raw) {
  const s = findSelection();
  if (!s) return;
  const L = editor.level;
  const value = parseNum(raw);
  const levelId = L.id;
  const lv = (pr) => pr.levels.find((l) => l.id === levelId);
  const needNum = !['wall-type', 'room-name'].includes(prop);
  if (needNum && !(Number.isFinite(value))) { toast('Valeur invalide.', 'warn'); renderInspector(); return; }
  store.commit('Modifier une valeur', (pr) => {
    const level = lv(pr);
    const wall = s.wall ? level.walls.find((w) => w.id === s.wall.id) : null;
    const op = s.opening ? wall.openings.find((o) => o.id === s.opening.id) : null;
    switch (prop) {
      case 'wall-type': wall.type = raw; wall.thickness = WALL_TYPES[raw].thickness; break;
      case 'wall-thickness': if (value < 0.03 || value > 1) return false; wall.thickness = value; break;
      case 'wall-length': {
        if (value < 0.05) return false;
        const a = level.nodes[wall.a], b = level.nodes[wall.b];
        const u = G.norm(G.sub(b, a));
        level.nodes[wall.b] = G.add(a, G.mul(u, value));
        M.clampOpenings(level);
        break;
      }
      case 'op-width': if (value < 0.2) return false; op.width = value; M.clampOpenings(level); break;
      case 'op-height': if (value < 0.2) return false; op.height = Math.min(value, M.wallHeight(pr, level) - op.sill); break;
      case 'op-sill': if (value < 0) return false; op.sill = Math.min(value, M.wallHeight(pr, level) - 0.2); op.height = Math.min(op.height, M.wallHeight(pr, level) - op.sill); break;
      case 'op-offset': op.offset = value + op.width / 2; M.clampOpenings(level); break;
      case 'node-x': level.nodes[s.id] = [value, level.nodes[s.id][1]]; M.clampOpenings(level); break;
      case 'node-y': level.nodes[s.id] = [level.nodes[s.id][0], -value]; M.clampOpenings(level); break;
      case 'room-name': {
        const room = level.rooms.find((r) => r.id === s.room.id);
        room.name = raw.trim() || room.name;
        break;
      }
      default: return false;
    }
    return true;
  });
}

// ─── Niveaux ──────────────────────────────────────────────────────────────────

function renderLevelTabs() {
  const p = store.project;
  $('#levelTabs').innerHTML = p.levels
    .map((l) => `<button data-level-tab="${l.id}" class="${l.id === editor.levelId ? 'on' : ''}">${esc(l.name)}</button>`)
    .join('') + '<button class="add" data-act="add-level" title="Ajouter un niveau" aria-label="Ajouter un niveau">+</button>';
}

function switchLevel(id) {
  editor.setLevel(id);
  editor.needsFit = false;
  renderAll();
  schedule3D();
}

function renameLevels(pr) {
  // renomme les niveaux dont le nom suit la convention automatique
  pr.levels.forEach((l, i) => {
    if (!l.name || l.name === 'Rez-de-chaussée' || /^R\+\d+$/.test(l.name)) l.name = M.levelName(i);
  });
}

async function duplicateLevel() {
  const src = editor.level;
  const choice = await modal({
    title: `Dupliquer « ${src.name} »`,
    body: `<p>Le nouveau niveau est placé juste au-dessus. Que faut-il recopier ?</p>
      <label class="check"><input type="checkbox" name="walls" checked /> Murs extérieurs et porteurs</label>
      <label class="check"><input type="checkbox" name="partitions" checked /> Cloisons</label>
      <label class="check"><input type="checkbox" name="openings" checked /> Portes et fenêtres</label>
      <label class="check"><input type="checkbox" name="rooms" checked /> Noms des pièces</label>`,
    actions: [
      { label: 'Annuler', id: null },
      {
        label: 'Dupliquer', kind: 'primary', default: true,
        value: (root) => Object.fromEntries([...root.querySelectorAll('input[type=checkbox]')].map((i) => [i.name, i.checked])),
      },
    ],
  });
  if (!choice) return;
  let newId = null;
  store.commit('Dupliquer un niveau', (pr) => {
    const i = pr.levels.findIndex((l) => l.id === src.id);
    const copy = M.duplicateLevelData(pr.levels[i], choice);
    copy.name = '';
    pr.levels.splice(i + 1, 0, copy);
    renameLevels(pr);
    newId = copy.id;
  });
  switchLevel(newId);
  toast(`Niveau ${editor.level.name} créé.`);
}

function addLevel() {
  let newId = null;
  store.commit('Ajouter un niveau', (pr) => {
    const top = pr.levels[pr.levels.length - 1];
    const l = M.newLevel('', top.height);
    pr.levels.push(l);
    renameLevels(pr);
    newId = l.id;
  });
  switchLevel(newId);
  toast(`Niveau ${editor.level.name} ajouté. Importez son plan ou dupliquez un étage existant.`);
}

async function deleteLevel() {
  const L = editor.level;
  const ok = await modal({
    title: `Supprimer « ${L.name} » ?`,
    body: '<p>Les murs, ouvertures et le plan de ce niveau seront retirés. Vous pourrez annuler avec Ctrl+Z.</p>',
    actions: [{ label: 'Annuler', id: false }, { label: 'Supprimer', kind: 'primary', id: true, default: true }],
  });
  if (!ok) return;
  const idx = editor.levelIndex;
  store.commit('Supprimer un niveau', (pr) => {
    pr.levels = pr.levels.filter((l) => l.id !== L.id);
    renameLevels(pr);
  });
  switchLevel(store.project.levels[Math.max(0, idx - 1)].id);
}

// ─── Plans ────────────────────────────────────────────────────────────────────

async function setPlanForLevel(levelId, image, meta = {}) {
  const assetId = M.uid('img');
  store.project.assets[assetId] = image.dataUrl;
  store.commit('Importer un plan', (pr) => {
    const L = pr.levels.find((l) => l.id === levelId);
    const below = pr.levels[pr.levels.findIndex((l) => l.id === levelId) - 1];
    const prev = L.plan;
    // conserve la position/échelle d'un plan précédent ou de l'étage inférieur (souvent même échelle)
    const ref = prev || below?.plan || null;
    L.plan = {
      assetId,
      width: image.width,
      height: image.height,
      x: ref ? ref.x : 0,
      y: ref ? ref.y : 0,
      scale: ref?.calibrated && ref.ptPerPx === meta.ptPerPx && ref.width === image.width ? ref.scale : 0.01,
      rotation: 0,
      opacity: 0.55,
      calibrated: !!(ref?.calibrated && ref.ptPerPx === meta.ptPerPx && ref.width === image.width && meta.ptPerPx),
      ptPerPx: meta.ptPerPx || null,
      source: meta.source || '',
    };
  });
}

async function importPlan(file) {
  const L = editor.level;
  try {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const done = busy('Lecture du PDF…');
      let pdf;
      try { pdf = await IO.openPdf(file); } finally { done(); }
      let pages = [1];
      if (pdf.numPages > 1) {
        const thumbs = [];
        const doneThumbs = busy('Préparation des pages…');
        try {
          for (let i = 1; i <= Math.min(pdf.numPages, 24); i++) thumbs.push((await IO.renderPdfPage(pdf, i, 260)).dataUrl);
        } finally { doneThumbs(); }
        const choice = await modal({
          title: `${pdf.numPages} pages dans ce PDF`,
          wide: true,
          body: `<p>Choisissez la page de « ${esc(L.name)} », ou créez un niveau par page (dans l'ordre, en partant de ${esc(L.name)}).</p>
            <div class="pages">${thumbs.map((t, i) => `<button class="page" data-page="${i + 1}"><img src="${t}" alt="Page ${i + 1}" />Page ${i + 1}</button>`).join('')}</div>`,
          actions: [{ label: 'Annuler', id: null }, { label: 'Un niveau par page', id: 'all' }],
          onMount: (root, close) => root.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => close(+b.dataset.page))),
        });
        if (!choice) return;
        pages = choice === 'all' ? [...Array(Math.min(pdf.numPages, 24)).keys()].map((i) => i + 1) : [choice];
      }
      const doneRender = busy('Rendu du plan…');
      try {
        let startIndex = editor.levelIndex;
        for (let k = 0; k < pages.length; k++) {
          const image = await IO.renderPdfPage(pdf, pages[k]);
          const idx = startIndex + k;
          if (!store.project.levels[idx]) {
            store.commit('Ajouter un niveau', (pr) => { pr.levels.push(M.newLevel('', pr.levels[pr.levels.length - 1].height)); renameLevels(pr); });
          }
          await setPlanForLevel(store.project.levels[idx].id, image, { ptPerPx: image.ptPerPx, source: `${file.name} p.${pages[k]}` });
        }
      } finally { doneRender(); }
      toast(pages.length > 1 ? `${pages.length} plans importés, un par niveau.` : 'Plan importé.');
    } else if (file.type.startsWith('image/')) {
      const dataUrl = await IO.readAsDataURL(file);
      const img = await IO.loadImage(dataUrl);
      await setPlanForLevel(L.id, { dataUrl, width: img.naturalWidth, height: img.naturalHeight }, { source: file.name });
      toast('Plan importé.');
    } else {
      toast('Format non pris en charge : utilisez une image ou un PDF.', 'warn');
      return;
    }
    editor.needsFit = true;
    editor.fit();
    goStep('scale');
  } catch (err) {
    console.error(err);
    toast(`Import impossible : ${err.message}`, 'warn');
  }
}

// ─── Export et projet ─────────────────────────────────────────────────────────

function hasContent() {
  return store.project.levels.some((l) => l.walls.length);
}

function doExportIfc() {
  if (!hasContent()) { toast('Tracez au moins un mur avant d’exporter.', 'warn'); return; }
  try {
    const text = exportIfc(store.project);
    IO.download(`${IO.safeName(store.project.name)}.ifc`, text, 'application/x-step');
    ui.exported = true;
    toast('IFC téléchargé.');
    renderSteps();
  } catch (err) {
    console.error(err);
    toast(`Export IFC impossible : ${err.message}`, 'warn');
  }
}

async function doExportGlb() {
  if (!hasContent()) { toast('Tracez au moins un mur avant d’exporter.', 'warn'); return; }
  const done = busy('Préparation du GLB…');
  try {
    const blob = await exportGlb(store.project);
    IO.download(`${IO.safeName(store.project.name)}.glb`, blob);
    toast('GLB téléchargé.');
  } catch (err) {
    console.error(err);
    toast(`Export GLB impossible : ${err.message}`, 'warn');
  } finally { done(); }
}

function saveProjectFile() {
  IO.download(`${IO.safeName(store.project.name)}.smelt.json`, JSON.stringify(store.project), 'application/json');
  toast('Projet enregistré.');
}

async function openProjectFile(file) {
  try {
    const data = M.validateProject(JSON.parse(await file.text()));
    loadProject(data);
    toast(`Projet « ${data.name} » ouvert.`);
  } catch (err) {
    toast(err.message || 'Fichier illisible.', 'warn');
  }
}

function loadProject(data) {
  editor.images.clear();
  store.load(data);
  editor.levelId = data.levels[0].id;
  editor.select(null);
  editor.needsFit = true;
  editor.fit();
  if (view3d) view3d.hasFramed = false;
  ui.step = data.levels[0].plan ? (data.levels[0].walls.length ? 'walls' : 'scale') : 'plan';
  renderAll();
  schedule3D(true);
}

async function newProjectFlow() {
  const ok = await modal({
    title: 'Commencer un nouveau projet ?',
    body: '<p>Le projet actuel sera remplacé. Pensez à l’enregistrer si vous souhaitez le garder.</p>',
    actions: [{ label: 'Annuler', id: false }, { label: 'Nouveau projet', kind: 'primary', id: true, default: true }],
  });
  if (!ok) return;
  loadProject(M.newProject('Ma maison'));
  ui.exported = false;
}

// ─── Rendu global et événements ───────────────────────────────────────────────

function renderAll() {
  const p = store.project;
  if (document.activeElement !== $('#projectName')) $('#projectName').value = p.name;
  renderLevelTabs();
  renderSteps();
  renderInspector();
  const L = editor.level;
  $('#emptyHint').hidden = !(p.levels.length === 1 && !L.plan && !L.walls.length && !ui.dismissedEmpty);
  $('#undoBtn').disabled = !store.undoStack.length;
  $('#redoBtn').disabled = !store.redoStack.length;
  editor.invalidate();
}

let saveTimer = null;
store.subscribe((reason) => {
  if (reason === 'live') {
    editor.invalidate();
    renderInspector();
    schedule3D();
    return;
  }
  renderAll();
  schedule3D();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => IO.saveLocal(store.project).catch((e) => console.warn('Sauvegarde locale impossible', e)), 700);
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-room], [data-level], a');
  if (!t) return;
  const d = t.dataset;
  if (d.step) { goStep(ui.step === d.step ? d.step : d.step); return; }
  if (d.go) { goStep(d.go); return; }
  if (d.tool && t.closest('#toolbar')) { setTool(d.tool); return; }
  if (d.levelTab) { switchLevel(d.levelTab); return; }
  if (d.level) { switchLevel(d.level); return; }
  if (d.mode && t.closest('#viewMode')) { setViewMode(d.mode); return; }
  if (d.wallType) { editor.wallType = d.wallType; setTool('wall'); return; }
  if (d.trace) { editor.traceMode = d.trace; setTool('wall'); return; }
  if (d.opening) { editor.openingType = d.opening; setTool('opening'); return; }
  if (d.room) { setTool('select'); editor.select({ type: 'room', id: d.room }); renderSteps(); return; }
  if (d.roomName) { applyProp('room-name', d.roomName); return; }
  if (d.roof) { store.commit('Type de toiture', (pr) => { pr.roof.type = d.roof; pr.roof.enabled = true; }); return; }
  const act = d.act;
  if (!act) return;
  const L = editor.level;
  const actions = {
    'import-plan': () => $('#planFile').click(),
    'remove-plan': () => store.commit('Retirer le plan', (pr) => { pr.levels.find((l) => l.id === L.id).plan = null; }),
    'tool-scale': () => setTool('scale'),
    'tool-measure': () => setTool('measure'),
    'tool-calage': () => setTool('calage'),
    'tool-move-plan': () => setTool('movePlan'),
    'rotate-plan': () => {
      if (!L.plan) return;
      const img = editor.images.get(L.plan.assetId);
      const center = img ? M.planImageToWorld(L.plan, [img.naturalWidth / 2, img.naturalHeight / 2]) : [L.plan.x, L.plan.y];
      store.commit('Pivoter le plan', (pr) => M.rotatePlan(pr.levels.find((l) => l.id === L.id).plan, +d.deg, center));
    },
    'apply-ratio': () => {
      const input = t.closest('.step-body').querySelector('[data-field="pdf-ratio"]');
      const ratio = parseNum(input.value);
      if (!(ratio > 0) || !L.plan?.ptPerPx) { toast("Indiquez l'échelle du PDF, par exemple 100 pour 1/100.", 'warn'); return; }
      const img = editor.images.get(L.plan.assetId);
      const anchor = img ? M.planImageToWorld(L.plan, [0, 0]) : [L.plan.x, L.plan.y];
      store.commit("Échelle du PDF", (pr) => {
        const pl = pr.levels.find((l) => l.id === L.id).plan;
        const target = pl.ptPerPx * (0.0254 / 72) * ratio; // mètres par pixel
        M.rescalePlan(pl, target / pl.scale, anchor);
        pl.calibrated = true;
      });
      editor.fit();
      setTool('measure');
      toast(`Échelle 1/${ratio} appliquée. Vérifiez une cote avec Mesurer : un PDF redimensionné à l'impression fausserait le résultat.`);
    },
    'add-level': addLevel,
    'dup-level': duplicateLevel,
    'del-level': deleteLevel,
    'export-ifc': doExportIfc,
    'export-glb': doExportGlb,
    'save-project': saveProjectFile,
    'open-project': () => $('#projectFile').click(),
    'new-project': newProjectFlow,
    'delete-selection': () => editor.deleteSelection(),
    'op-flip-side': () => {
      const s = findSelection();
      store.commit('Inverser la porte', (pr) => { const o = pr.levels.find((l) => l.id === L.id).walls.find((w) => w.id === s.wall.id).openings.find((x) => x.id === s.opening.id); o.side = -(o.side || 1); });
    },
    'op-flip-hinge': () => {
      const s = findSelection();
      store.commit('Inverser la porte', (pr) => { const o = pr.levels.find((l) => l.id === L.id).walls.find((w) => w.id === s.wall.id).openings.find((x) => x.id === s.opening.id); o.hinge = o.hinge === 'end' ? 'start' : 'end'; });
    },
  };
  actions[act]?.();
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const d = t.dataset;
  if (d.prop) { applyProp(d.prop, t.value); return; }
  if (d.live === 'plan-opacity' || d.live === 'roof-pitch') {
    const levelId = editor.levelId;
    const v = +t.value;
    // on remet la valeur d'origine puis on enregistre une étape d'annulation propre
    if (store.gesture) store.endGesture();
    else store.commit('Modifier un réglage', (pr) => {
      if (d.live === 'plan-opacity') pr.levels.find((l) => l.id === levelId).plan.opacity = v;
      else pr.roof.pitch = v;
    });
    return;
  }
  const field = d.field;
  if (!field) return;
  const L = editor.level;
  const v = parseNum(t.value);
  const bad = () => { toast('Valeur invalide.', 'warn'); renderSteps(); };
  switch (field) {
    case 'level-height':
      if (!(v >= 1.8 && v <= 10)) return bad();
      store.commit("Hauteur d'étage", (pr) => { pr.levels.find((l) => l.id === L.id).height = v; });
      break;
    case 'slab':
      if (!(v >= 0.05 && v <= 1)) return bad();
      store.commit('Épaisseur des planchers', (pr) => { pr.settings.slabThickness = v; });
      break;
    case 'roof-enabled':
      store.commit('Toiture', (pr) => { pr.roof.enabled = t.checked; });
      break;
    case 'roof-overhang':
      if (!(v >= 0 && v <= 2)) return bad();
      store.commit('Débord de toiture', (pr) => { pr.roof.overhang = v; });
      break;
    case 'roof-thickness':
      if (!(v >= 0.05 && v <= 1)) return bad();
      store.commit('Épaisseur de toiture', (pr) => { pr.roof.thickness = v; });
      break;
    default: break;
  }
});

document.addEventListener('input', (e) => {
  const d = e.target.dataset;
  if (d.live === 'plan-opacity' || d.live === 'roof-pitch') {
    const levelId = editor.levelId;
    const v = +e.target.value;
    if (!store.gesture) store.beginGesture('Modifier un réglage');
    store.live((pr) => {
      if (d.live === 'plan-opacity') pr.levels.find((l) => l.id === levelId).plan.opacity = v;
      else pr.roof.pitch = v;
    });
    if (d.live === 'roof-pitch') {
      const label = e.target.closest('label').querySelector('.field-label');
      if (label) label.textContent = `Pente : ${Math.round(v)}°`;
    }
  }
});

$('#projectName').addEventListener('change', (e) => {
  const name = e.target.value.trim() || 'Projet sans nom';
  store.commit('Renommer le projet', (pr) => { pr.name = name; });
});

$('#planFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importPlan(f);
});
$('#projectFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openProjectFile(f);
});

// glisser-déposer d'un plan ou d'un projet sur la page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (/\.json$/i.test(f.name)) openProjectFile(f);
  else importPlan(f);
});

$('#undoBtn').addEventListener('click', () => { const l = store.undo(); if (l) toast(`Annulé : ${l}`); });
$('#redoBtn').addEventListener('click', () => { const l = store.redo(); if (l) toast(`Rétabli : ${l}`); });
$('#exportTop').addEventListener('click', doExportIfc);
$('#fitBtn').addEventListener('click', () => editor.fit());
$('#frame3d').addEventListener('click', () => view3d?.frame());
$('#scopeBtn').addEventListener('click', (e) => {
  ui.scope = ui.scope === 'all' ? 'upto' : 'all';
  e.target.textContent = ui.scope === 'all' ? 'Tous les niveaux' : "Jusqu'au niveau affiché";
  schedule3D(true);
});
$('#emptyImport').addEventListener('click', () => $('#planFile').click());
$('#emptyDraw').addEventListener('click', () => { ui.dismissedEmpty = true; goStep('walls'); renderAll(); });

window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); $('#undoBtn').click(); }
  else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); $('#redoBtn').click(); }
  else if (ctrl && k === 's') { e.preventDefault(); saveProjectFile(); }
  else if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault();
    const i = editor.levelIndex + (e.key === 'PageUp' ? 1 : -1);
    const l = store.project.levels[i];
    if (l) switchLevel(l.id);
  } else if (k === '3' && !ctrl) {
    setViewMode(ui.viewMode === 'plan' ? 'split' : ui.viewMode === 'split' ? '3d' : 'plan');
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

(async () => {
  try {
    const saved = await IO.loadLocal();
    if (saved) {
      loadProject(M.validateProject(saved));
      toast('Projet restauré depuis la dernière session.');
      return;
    }
  } catch (err) {
    console.warn('Restauration impossible', err);
  }
  renderAll();
})();

// Accès console pour le débogage
window.smelt = { store, editor, exportIfc: () => exportIfc(store.project) };
