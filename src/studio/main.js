// Smelt Studio — point d'entrée de l'interface.
import * as M from './model.js';
import * as G from './geometry.js';
import { WALL_TYPES, OPENING_TYPES, ROOM_NAMES, ROOF_TYPES, ROOF_OPENINGS, COLOR_LABELS, colorsOf, BALCONY, RAILING_TYPES, SITE_SURFACES, SITE_DEFAULTS, TREE_KINDS } from './catalog.js';
import { Editor2D } from './editor2d.js';
import { View3D, exportGlb } from './view3d.js';
import { exportIfc } from './ifc-export.js';
import * as B from './build.js';
import { autoAlignPlan, applyAlignment, referenceWalls } from './plan-align.js';
import { SHUTTER_MODES } from './joinery.js';
import { STAIR_TYPES, STAIR_LIMITS, STAIR_RAILS, isTurningStair, stairLayout } from './stairs.js';
import { EQUIPMENT_TYPES, EQUIPMENT_GROUPS } from './equipment-catalog.js';
import { equipmentIcon } from './equipment-plan.js';
import * as IO from './io.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => Number(v).toFixed(d).replace('.', ',');
const parseNum = (v) => parseFloat(String(v).replace(',', '.'));

const store = new M.Store(M.newProject('Ma maison'));
const ui = { step: 'plan', viewMode: 'plan', scope: 'all', exported: false, colorScope: 'project' };

function applyColor(pr, scope, key, value) {
  if (scope === 'project') pr.colors = { ...(pr.colors || {}), [key]: value };
  else {
    const b = M.bodyById(pr, scope);
    b.colors = { ...(b.colors || {}), [key]: value };
  }
}

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
  onSelect: () => { renderInspector(); if (ui.step === 'bodies' || ui.step === 'rooms') renderSteps(); },
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
  requestLevel: (id) => switchLevel(id),
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
  if (!view3d) {
    view3d = new View3D($('#viewPane'));
    // pose d'une ouverture de toiture directement dans la 3D : c'est là que les pans existent
    view3d.onPick = (hit) => {
      if (editor.tool !== 'skylight') return;
      if (hit.key && !hit.key.startsWith('roof-')) {
        toast('Cliquez sur un pan de toiture.', 'warn');
        return;
      }
      editor.skylightClick(hit.point);
    };
  }
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
      selectedWallId: sel?.type === 'wall' ? sel.id : null,
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
  if (tool !== 'planAdjust' && ui.alignBanner && tool !== 'select') ui.alignBanner = null;
  renderAlignBanner();
  if (tool === 'skylight' && ui.viewMode === 'plan') setViewMode('split');
  renderSteps();
}

// ─── Parcours (colonne de gauche) ─────────────────────────────────────────────

const STEPS = [
  { id: 'plan', title: 'Importer le plan', tool: 'select' },
  { id: 'scale', title: "Mettre à l'échelle", tool: null },
  { id: 'walls', title: 'Tracer les murs', tool: 'wall' },
  { id: 'openings', title: 'Poser portes et fenêtres', tool: 'opening' },
  { id: 'rooms', title: 'Nommer les pièces', tool: 'select' },
  { id: 'equipment', title: 'Équiper les pièces', tool: 'equipment' },
  { id: 'bodies', title: 'Corps de bâtiment', tool: 'select' },
  { id: 'levels', title: 'Gérer les étages', tool: 'select' },
  { id: 'roof', title: 'Couvrir', tool: 'select' },
  { id: 'site', title: 'Aménager les abords', tool: 'select' },
  { id: 'export', title: 'Exporter', tool: 'select' },
];

const activeBody = () => M.bodyById(store.project, store.project.activeBodyId);
const roofBody = () => M.bodyById(store.project, ui.roofBodyId || store.project.activeBodyId);
const editBody = (id, label, fn) => store.commit(label, (pr) => { fn(M.bodyById(pr, id)); });
const roomCountOf = (bodyId) => store.project.levels.reduce((n, l) => n + l.rooms.filter((r) => r.bodyId === bodyId).length, 0);

function stepDone(id) {
  const p = store.project;
  const L = editor.level;
  switch (id) {
    case 'plan': return !!L.plan;
    case 'scale': return !!L.plan?.calibrated;
    case 'walls': return L.walls.length > 0;
    case 'openings': return L.walls.some((w) => w.openings.length);
    case 'rooms': return L.rooms.length > 0 && L.rooms.every((r) => !/^Pièce \d+$/.test(r.name));
    case 'bodies': return p.bodies.length > 1;
    case 'equipment': return (L.equipment || []).length > 0;
    case 'levels': return p.levels.length > 1;
    case 'roof': return p.bodies.some((b) => b.roof.enabled) && p.levels[p.levels.length - 1].walls.length > 0;
    case 'site': return (p.site?.boundary?.length || 0) >= 3 || ['surfaces', 'parkings', 'trees', 'hedges'].some((k) => p.site?.[k]?.length);
    case 'export': return ui.exported;
    default: return false;
  }
}

function goStep(id) {
  if (id === 'site' && editor.levelIndex !== 0) switchLevel(store.project.levels[0].id);
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
  if (o.operation === 'sectional') {
    return `<svg viewBox="0 0 100 30" aria-hidden="true"><path d="M0 26H${x0}M${x0 + w} 26H100" stroke="#26323a" stroke-width="5"/><path d="M${x0} 24H${x0 + w}" stroke="#1f2a30" stroke-width="2.2"/><path d="M${x0} 22V4H${x0 + w}V22" fill="none" stroke="#1f2a30" stroke-dasharray="2 2"/></svg>`;
  }
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
      const ref = alignReference();
      const upper = editor.levelIndex > 0;
      const pdf = plan.ptPerPx
        ? `<label class="field"><span class="field-label">Échelle indiquée sur le PDF</span>
            <div class="inline"><span>1 /</span><input type="text" inputmode="numeric" placeholder="100" data-field="pdf-ratio" style="width:90px" /><button class="btn" data-act="apply-ratio">Appliquer</button></div></label>` : '';
      const scaleBlock = plan.scaleFrom
        ? `<p class="ok">Échelle reprise de ${esc(plan.scaleFrom)}, le même dossier en général.</p>
           <div class="row"><button class="btn ghost" data-act="tool-measure">Vérifier une cote</button><button class="btn ghost" data-act="tool-scale">Refaire l'échelle</button></div>`
        : `${plan.calibrated ? '<p class="ok">Échelle réglée. Vérifiez sur une deuxième cote avec l\'outil Mesurer.</p>' : '<p class="note">Indispensable avant de tracer : sans échelle, les murs n\'auront pas les bonnes dimensions.</p>'}
           <p>Cliquez les deux extrémités d'une cote connue, puis saisissez sa longueur réelle. Plus la cote est longue, plus l'échelle est précise.</p>
           <div class="row">
             <button class="btn ${plan.calibrated ? '' : 'primary'}" data-act="tool-scale">${plan.calibrated ? "Refaire l'échelle" : 'Mesurer une cote'}</button>
             <button class="btn" data-act="tool-measure">Vérifier une cote</button>
           </div>${pdf}`;
      const alignBlock = upper && ref
        ? `<section style="margin-top:14px">
            <span class="field-label">Superposer ce plan</span>
            <p>Smelt cherche la position qui fait tomber le plan sur ${esc(ref.label)}, les murs extérieurs se superposant d'un étage à l'autre.</p>
            <div class="row">
              <button class="btn ${plan.calibrated ? 'primary' : ''}" data-act="align-auto" ${plan.calibrated ? '' : 'disabled'}>Caler automatiquement</button>
              <button class="btn" data-act="plan-adjust">Ajuster à la main</button>
            </div>
            <details class="more"><summary>Autres méthodes</summary>
              <div class="row"><button class="btn ghost" data-act="tool-align2">Caler sur 2 points</button><button class="btn ghost" data-act="tool-calage">Caler par un point</button></div>
              <div class="row"><button class="btn ghost" data-act="rotate-plan" data-deg="-90">Pivoter à gauche</button><button class="btn ghost" data-act="rotate-plan" data-deg="90">Pivoter à droite</button></div>
            </details>
          </section>`
        : `<div class="row" style="margin-top:6px"><button class="btn ghost" data-act="plan-adjust">Déplacer ou tourner le plan</button></div>`;
      return scaleBlock + alignBlock;
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
        <p>Survolez un mur : les distances aux angles s'affichent. Cliquez pour poser. Dimensions modifiables ensuite à droite.</p>
        <span class="field-label">Volets battants, sur toutes les fenêtres de façade</span>
        <div class="row">${Object.entries(SHUTTER_MODES).map(([k, v]) => `<button class="btn ghost" data-act="shutters-all" data-mode="${k}">${esc(v)}</button>`).join('')}</div>
        <span class="field-label">Balcons</span>
        <div class="grid2">
          <button class="tile ${editor.tool === 'balcony' ? 'on' : ''}" data-act="tool-balcony">
            <svg viewBox="0 0 100 30" aria-hidden="true"><path d="M0 8H100" stroke="#26323a" stroke-width="6"/><rect x="28" y="11" width="44" height="15" fill="#e9dfd2" stroke="#1f2a30" stroke-width="1"/><path d="M28 11V26H72V11" fill="none" stroke="#1f2a30" stroke-width="2.4"/></svg>
            <span>${esc(BALCONY.label)}</span><small>${fmt(BALCONY.width)} × ${fmt(BALCONY.depth)} m</small>
          </button>
        </div>
        ${editor.levelIndex > 0 ? '<p>Les terrasses se créent seules : toute partie de l\'étage du dessous que ce niveau ne couvre pas devient une terrasse. Cliquez-la pour la régler.</p>' : ''}`;
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
    case 'equipment': {
      const count = (L.equipment || []).length;
      return `
        <p>Choisissez un équipement puis cliquez dans une pièce pour le poser.</p>
        ${Object.entries(EQUIPMENT_GROUPS).map(([group, title]) => `
          <span class="field-label">${esc(title)}</span>
          <div class="grid2">${Object.entries(EQUIPMENT_TYPES).filter(([, x]) => x.group === group).map(([k, x]) => `
            <button class="tile ${editor.equipmentType === k && editor.tool === 'equipment' ? 'on' : ''}" data-equipment-type="${k}">
              ${equipmentIcon(k)}<span>${esc(x.label)}</span><small>${fmt(x.width)} × ${fmt(x.depth)} m</small>
            </button>`).join('')}</div>`).join('')}
        <ul class="keys">
          <li>Clic : poser dans une pièce. <kbd>R</kbd> : pivoter de 90°.</li>
          <li><kbd>V</kbd> : revenir à la sélection pour déplacer un élément.</li>
          <li><kbd>Suppr</kbd> : supprimer l'élément sélectionné.</li>
        </ul>
        ${count ? `<p class="ok">${count} équipement${count > 1 ? 's' : ''} sur ce niveau.</p>` : ''}`;
    }
    case 'site': {
      const S = store.project.site;
      const area = S.boundary.length >= 3 ? Math.abs(G.polygonArea(S.boundary)) : 0;
      const tile = (attrs, on, icon, label, small = '') => `
        <button class="tile ${on ? 'on' : ''}" ${attrs}>${icon}<span>${esc(label)}</span>${small ? `<small>${small}</small>` : ''}</button>`;
      const sw = (c) => `<svg viewBox="0 0 100 30" aria-hidden="true"><rect x="28" y="5" width="44" height="20" rx="3" fill="${c}" stroke="#1f2a30" stroke-width="1"/></svg>`;
      const treeIcon = (conifer) => conifer
        ? '<svg viewBox="0 0 100 30" aria-hidden="true"><circle cx="50" cy="15" r="12" fill="#e2ead9" stroke="#2f5d3a"/><path d="M50 3v24M38 15h24M42 7l16 16M58 7 42 23" stroke="#2f5d3a"/></svg>'
        : '<svg viewBox="0 0 100 30" aria-hidden="true"><circle cx="50" cy="15" r="12" fill="#e2ead9" stroke="#2f5d3a" stroke-dasharray="4 2"/><circle cx="50" cy="15" r="1.8" fill="#6b5440"/></svg>';
      return `
        <p>Les abords se dessinent sur le rez-de-chaussée. Tracer au clic, fermer en cliquant le premier point ou avec Entrée.</p>
        <span class="field-label">Parcelle</span>
        ${area ? `<div class="stat"><span>Surface de la parcelle</span><b>${fmt(area, 0)} m²</b></div>` : ''}
        <div class="row"><button class="btn ${area ? '' : 'primary'} ${editor.tool === 'sitePoly' && editor.siteMode === 'boundary' ? 'on' : ''}" data-site-tool="boundary">${area ? 'Retracer la parcelle' : 'Tracer la parcelle'}</button></div>
        <span class="field-label">Surfaces</span>
        <div class="grid2">${Object.entries(SITE_SURFACES).map(([k, c]) => tile(`data-site-tool="${k}"`, editor.tool === 'sitePoly' && editor.siteMode === k, sw(c.color), c.label)).join('')}</div>
        <span class="field-label">Stationnement et végétation</span>
        <div class="grid2">
          ${tile('data-site-tool="parking"', editor.tool === 'parking', '<svg viewBox="0 0 100 30" aria-hidden="true"><path d="M38 27V3h24v24" fill="none" stroke="#1f2a30" stroke-width="2"/><text x="50" y="20" font-size="12" text-anchor="middle" font-weight="600" fill="#1f2a30">P</text></svg>', 'Place de stationnement', '2,50 × 5,00 m')}
          ${tile('data-site-tool="tree-deciduous"', editor.tool === 'tree' && editor.treeKind === 'deciduous', treeIcon(false), 'Arbre feuillu')}
          ${tile('data-site-tool="tree-conifer"', editor.tool === 'tree' && editor.treeKind === 'conifer', treeIcon(true), 'Conifère')}
          ${tile('data-site-tool="hedge"', editor.tool === 'hedge', '<svg viewBox="0 0 100 30" aria-hidden="true"><path d="M20 20 45 10 80 18" fill="none" stroke="#4f7a3c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Haie')}
        </div>
        <p class="sub">${S.surfaces.length} surface(s), ${S.parkings.length} place(s), ${S.trees.length} arbre(s), ${S.hedges.length} haie(s).</p>`;
    }
    case 'bodies': {
      const sel = editor.selection?.type === 'room' ? L.rooms.find((r) => r.id === editor.selection.id) : null;
      const b = activeBody();
      return `
        <p>Un corps de bâtiment regroupe des pièces qui partagent une altitude de sol, une hauteur de murs et une toiture : la maison d'un côté, le garage accolé de l'autre. Le mur mitoyen monte au plus haut des deux.</p>
        <table class="table"><tbody>${p.bodies.map((x) => `<tr data-body="${x.id}" class="${x.id === b.id ? 'sel' : ''}"><td>${esc(x.name)}</td><td>${roomCountOf(x.id)} pièce${roomCountOf(x.id) > 1 ? 's' : ''}</td></tr>`).join('')}</tbody></table>
        <div class="row">
          <button class="btn ${sel ? 'primary' : ''}" data-act="new-body" ${sel ? '' : 'disabled'}>Nouveau corps depuis « ${esc(sel ? sel.name : 'une pièce')} »</button>
        </div>
        ${sel ? `<label class="field"><span class="field-label">« ${esc(sel.name)} » appartient à</span>
          <select data-prop="room-body">${p.bodies.map((x) => `<option value="${x.id}" ${x.id === (sel.bodyId || p.bodies[0].id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
          : '<p>Sélectionnez une pièce sur le plan pour la rattacher à un corps.</p>'}
        <section style="margin-top:14px">
          <span class="field-label">Réglages de « ${esc(b.name)} »</span>
          <label class="field"><span class="field-label">Nom</span><input type="text" value="${esc(b.name)}" data-field="body-name" /></label>
          <div class="grid2">
            <label><span class="field-label">Altitude du sol</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(b.elevation)}" data-field="body-elevation" /></span></label>
            <label><span class="field-label">Hauteur des murs</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${b.height ? fmt(b.height) : ''}" placeholder="${fmt(L.height)}" data-field="body-height" /></span></label>
          </div>
          <p class="sub">Laissez la hauteur vide pour suivre celle du niveau. L'altitude est un décalage par rapport au plancher du niveau : -0,15 pour un garage plus bas.</p>
          <label class="check"><input type="checkbox" data-field="body-draw" ${p.drawBodyId === b.id ? 'checked' : ''} /> Rattacher à ce corps les prochaines pièces tracées</label>
          <p class="sub">Sinon, une pièce qui apparaît hérite du corps de ses voisines : sélectionner un corps ici ne déplace jamais vos pièces.</p>
          <button class="btn block" data-act="assign-all">Rattacher toutes les pièces de ${esc(L.name)} à « ${esc(b.name)} »</button>
          ${p.bodies.length > 1 && p.bodies[0].id !== b.id ? `<button class="btn ghost danger block" data-act="del-body">Supprimer « ${esc(b.name)} »</button>` : ''}
        </section>`;
    }
    case 'levels':
      return `
        <table class="table"><tbody>${p.levels.map((l, i) => `<tr data-level="${l.id}" class="${l.id === L.id ? 'sel' : ''}"><td>${esc(l.name)}</td><td>+${fmt(M.levelElevation(p, l.id))} m</td></tr>`).slice().reverse().join('')}</tbody></table>
        <label class="field"><span class="field-label">Type d'étage</span>
          <select data-field="level-attic">
            <option value="standard" ${M.isAttic(L) ? '' : 'selected'}>Standard</option>
            <option value="attic" ${M.isAttic(L) ? 'selected' : ''}>Sous toiture (combles aménagés)</option>
          </select></label>
        ${M.isAttic(L) ? atticPanel(L) : ''}
        ${stairPanel(L)}
        <label class="field"><span class="field-label">Hauteur d'étage de « ${esc(L.name)} » (sol à sol)</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(L.height)}" data-field="level-height" /></span></label>
        <label class="field"><span class="field-label">Épaisseur des planchers</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(p.settings.slabThickness)}" data-field="slab" /></span></label>
        <div class="row">
          <button class="btn primary" data-act="dup-level">Dupliquer « ${esc(L.name)} »</button>
          <button class="btn" data-act="add-level">Niveau vide</button>
        </div>
        ${p.levels.length > 1 ? `<button class="btn ghost danger" data-act="del-level">Supprimer « ${esc(L.name)} »</button>` : ''}`;
    case 'roof': {
      const body = roofBody();
      const r = body.roof;
      const topIdx = M.bodyTopLevelIndex(p, body.id);
      const top = p.levels[topIdx] || p.levels[p.levels.length - 1];
      return `
        ${p.bodies.length > 1 ? `<label class="field"><span class="field-label">Toiture de</span><select data-field="roof-body">${p.bodies.map((x) => `<option value="${x.id}" ${x.id === body.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
        <label class="check"><input type="checkbox" data-field="roof-enabled" ${r.enabled ? 'checked' : ''} /> Générer une toiture</label>
        <p>Elle se pose sur le contour de ${esc(body.name)}, au sommet de ${esc(top.name)}.</p>
        <div class="grid2">${Object.entries(ROOF_TYPES).map(([k, label]) => `<button class="tile ${r.type === k ? 'on' : ''}" data-roof="${k}">${roofIcon(k)}<span>${label}</span></button>`).join('')}</div>
        ${r.type !== 'flat' ? `<label class="field"><span class="field-label">Pente : ${Math.round(r.pitch)}°</span><input type="range" min="5" max="${r.type === 'shed' ? 30 : 60}" step="1" value="${r.pitch}" data-live="roof-pitch" /></label>` : ''}
        ${r.type === 'gable' || r.type === 'hip' || r.type === 'shed' ? `<label class="check"><input type="checkbox" data-field="roof-flip" ${r.ridgeFlip ? 'checked' : ''} /> Tourner ${r.type === 'shed' ? 'la pente' : 'le faîtage'} d'un quart de tour</label>` : ''}
        ${r.type === 'gable' || r.type === 'hip' ? roofShapeFields(body) : ''}
        ${r.enabled ? `<p>Point le plus haut : ${ridgeInfo(body)}</p>` : ''}
        ${r.enabled ? `<section style="margin-top:14px">
          <span class="field-label">Ouvertures de toiture</span>
          <div class="grid2">${Object.entries(ROOF_OPENINGS).map(([k, o]) => `
            <button class="tile ${editor.roofOpeningType === k ? 'on' : ''}" data-roofopening="${k}">${roofOpeningIcon(k)}<span>${esc(o.label)}</span></button>`).join('')}</div>
          <p>Cliquez sur un pan, dans le plan ou directement dans la vue 3D.</p>
          <button class="btn ${editor.tool === 'skylight' ? 'primary' : ''}" data-act="tool-skylight">Poser : ${esc((ROOF_OPENINGS[editor.roofOpeningType] || ROOF_OPENINGS.skylight).label)}</button>
          ${skylightList()}
        </section>` : ''}
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

// Hauteur du point le plus haut de la toiture, pour éviter les pentes déraisonnables
// La fenêtre est-elle au-dessus du plafond du corps ?
function aboveCeiling(s) {
  const body = s.body;
  if (!body?.ceiling || !s.info?.poly) return false;
  const idx = M.bodyTopLevelIndex(store.project, body.id);
  const level = store.project.levels[idx];
  if (!level || M.isAttic(level)) return false; // attic ceilings are pierced below skylights
  const zPlafond = M.levelElevation(store.project, level.id) + (body.elevation || 0)
    + (M.isAttic(level) ? (level.attic.ceilingHeight ?? 2.5) : M.bodyHeight(store.project, level, body) - (body.ceilingThickness || 0.15));
  return s.info.sillZ >= zPlafond - 0.02;
}

// Escaliers qui partent de ce niveau
function stairPanel(L) {
  const idx = editor.levelIndex;
  const above = store.project.levels[idx + 1];
  const icon = (type) => type === 'winder'
    ? '<svg viewBox="0 0 100 30" aria-hidden="true"><path d="M30 26V4h40v22H46V20H30M30 9h16M30 14h16M46 20V4M46 20L54 4M46 20L62 4M46 20L70 12M46 20h24" fill="none" stroke="#1f2a30" stroke-width="1.2"/><path d="M38 26V16Q38 10 48 10H65" fill="none" stroke="#e8672a" stroke-width="1.6"/></svg>'
    : type === 'quarter'
    ? '<svg viewBox="0 0 100 30" aria-hidden="true"><path d="M30 4h24v22H30M54 4h16v22H54M30 9h24M30 14h24M30 19h24M54 4v22" fill="none" stroke="#1f2a30" stroke-width="1.2"/><path d="M36 26V8h26" fill="none" stroke="#e8672a" stroke-width="1.6"/></svg>'
    : '<svg viewBox="0 0 100 30" aria-hidden="true"><rect x="20" y="9" width="60" height="12" fill="none" stroke="#1f2a30" stroke-width="1.2"/><path d="M28 9v12M36 9v12M44 9v12M52 9v12M60 9v12M68 9v12" stroke="#1f2a30" stroke-width="1"/><path d="M22 15h54" stroke="#e8672a" stroke-width="1.6"/></svg>';
  return `
    <section style="margin-top:14px">
      <span class="field-label">Escaliers</span>
      <div class="grid2">${Object.entries(STAIR_TYPES).map(([k, label]) => `
        <button class="tile ${editor.tool === 'stair' && editor.stairType === k ? 'on' : ''}" data-stair-type="${k}">${icon(k)}<span>${esc(label)}</span></button>`).join('')}</div>
      <p class="sub">Cliquez le départ, puis le sens de la montée. Les marches se calculent sur la hauteur d'étage (${fmt(L.height)} m) et la trémie se perce dans le plancher de ${esc(above?.name || "l'étage du dessus")}.</p>
      <p class="sub">Sélectionnez ensuite l'escalier pour régler séparément les marches avant et après le virage.</p>
      ${above ? '' : '<p class="note">Aucun étage au-dessus : ajoutez-en un pour que l\'escalier y arrive.</p>'}
    </section>`;
}

// Réglages et bilan d'un étage sous toiture
function atticPanel(L) {
  const p = store.project;
  const idx = editor.levelIndex;
  const covered = [...new Set(L.rooms.map((r) => r.bodyId || p.bodies[0].id))]
    .some((id) => M.bodyTopLevelIndex(p, id) === idx);
  const els = B.buildElements(p).elements.filter((e) => e.kind === 'space' && e.levelIndex === idx && e.areaHabitable !== undefined);
  const floor = els.reduce((a, e) => a + e.area, 0), habitable = els.reduce((a, e) => a + e.areaHabitable, 0);
  const warns = B.buildElements(p).warnings.filter((w) => w.startsWith(`${L.name} :`));
  return `
    <div class="grid2">
      <label><span class="field-label">Jambettes (murs de façade)</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(L.attic.kneeWall ?? 0.9)}" data-field="attic-knee" /></span></label>
      <label><span class="field-label">Faux plafond</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(L.attic.ceilingHeight ?? 2.5)}" data-field="attic-ceiling" /></span></label>
    </div>
    <p class="sub">La toiture repose sur les jambettes ; cloisons et pièces s'arrêtent sous les rampants. Le faux plafond suit l'option « Plafond sous la toiture » du corps : décochée, les rampants montent jusqu'au faîtage.</p>
    ${covered ? '' : '<p class="note">Aucune toiture ne repose sur ce niveau : il faut que ce soit le dernier niveau de son corps de bâtiment.</p>'}
    ${els.length ? `<div class="stat"><span>Surface au sol</span><b>${fmt(floor, 1)} m²</b></div>
      <div class="stat"><span>Surface habitable (≥ 1,80 m)</span><b>${fmt(habitable, 1)} m²</b></div>` : ''}
    ${warns.map((w) => `<p class="note">${esc(w.replace(`${L.name} : `, ''))}</p>`).join('')}`;
}

function skylightList() {
  const rows = [];
  for (const b of store.project.bodies) {
    for (const o of B.roofOpenings(store.project, editor.level, b)) {
      rows.push(`<tr data-skylight="${o.item.id}" data-skylight-body="${b.id}"><td>${esc(b.name)}</td><td>${o.poly ? `${fmt(o.sillZ - o.floorZ)} m${o.clamped ? ' (recalée)' : ''}` : 'hors toiture'}</td></tr>`);
    }
  }
  if (!rows.length) return '';
  return `<table class="table" style="margin-top:8px"><tbody>${rows.join('')}</tbody></table>`;
}

// Emprise et extrémités d'une toiture à deux ou quatre pans
function roofShapeFields(body) {
  const r = body.roof;
  const footprint = r.footprint || (r.followSetbacks ? 'follow' : 'auto');
  const ends = r.ends || (r.type === 'hip' ? { min: 'hip', max: 'hip' } : { min: 'gable', max: 'gable' });
  // repère des extrémités dans le plan : faîtage plutôt horizontal → gauche/droite, sinon haut/bas
  const p = store.project;
  const top = p.levels[M.bodyTopLevelIndex(p, body.id)];
  const outline = top ? M.bodyOutlines(p, top, body.id, 1)[0] : null;
  const axis = outline ? G.buildRoof(outline, { ...r, baseZ: 0 }).ridgeAxis : 'x';
  const [minLabel, maxLabel] = axis === 'y' ? ['du haut', 'du bas'] : ['de gauche', 'de droite'];
  const endSelect = (key, label) => `
    <label><span class="field-label">Extrémité ${label}</span>
      <select data-field="roof-end-${key}">
        <option value="gable" ${ends[key] !== 'hip' ? 'selected' : ''}>Pignon</option>
        <option value="hip" ${ends[key] === 'hip' ? 'selected' : ''}>Croupe</option>
      </select></label>`;
  const count = 2 + (ends.min === 'hip') + (ends.max === 'hip');
  return `
    <label class="field"><span class="field-label">Emprise de la toiture</span>
      <select data-field="roof-footprint">
        <option value="auto" ${footprint === 'auto' ? 'selected' : ''}>Automatique</option>
        <option value="rect" ${footprint === 'rect' ? 'selected' : ''}>Un seul toit sur le rectangle</option>
        <option value="follow" ${footprint === 'follow' ? 'selected' : ''}>Suivre tous les décrochés</option>
      </select></label>
    <p class="sub">${{
      auto: 'Une emprise presque rectangulaire reçoit un seul toit ; une forme en L ou en T, un toit par aile.',
      rect: "Un seul toit couvre le rectangle du bâtiment, même si un angle est occupé (garage, porche) : c'est le cas d'une maison dont le garage a sa propre toiture.",
      follow: 'Chaque avancée ou renfoncement de façade reçoit son propre pan.',
    }[footprint]}</p>
    <div class="grid2">${endSelect('min', minLabel)}${endSelect('max', maxLabel)}</div>
    <p class="sub">${count} pans : ${count === 2 ? 'deux pignons' : count === 4 ? 'deux croupes' : 'une croupe et un pignon'}.</p>`;
}

function ridgeInfo(body) {
  const p = store.project;
  const idx = M.bodyTopLevelIndex(p, body.id);
  const top = p.levels[idx];
  if (!top) return 'à définir (aucune pièce fermée dans ce corps)';
  const outlines = M.bodyOutlines(p, top, body.id, 1);
  if (!outlines.length) return 'à définir (aucun contour fermé)';
  const baseZ = M.levelElevation(p, top.id) + (body.elevation || 0) + M.roofBaseHeight(p, top, body);
  let z = baseZ;
  for (const o of outlines) z = Math.max(z, G.buildRoof(o, { ...body.roof, baseZ }).ridgeZ);
  return `+${fmt(z)} m, soit ${fmt(z - baseZ)} m au-dessus des murs`;
}

function roofOpeningIcon(key) {
  const icons = {
    skylight: '<path d="M8 24 50 6 92 24" fill="none" stroke="#9b5a43" stroke-width="3"/><rect x="38" y="12" width="20" height="10" fill="#9cc3d6" stroke="#1f2a30" stroke-width="1.5" transform="rotate(-8 48 17)"/>',
    dormerGable: '<path d="M8 26 50 6 92 26" fill="none" stroke="#9b5a43" stroke-width="3"/><path d="M36 26V16l12-8 12 8v10" fill="#efe9e1" stroke="#1f2a30" stroke-width="1.5"/><rect x="42" y="16" width="12" height="10" fill="#9cc3d6" stroke="#1f2a30" stroke-width="1"/>',
    dormerHip: '<path d="M8 26 50 6 92 26" fill="none" stroke="#9b5a43" stroke-width="3"/><path d="M36 26V16h24v10" fill="#efe9e1" stroke="#1f2a30" stroke-width="1.5"/><path d="M36 16 48 9 60 16" fill="none" stroke="#1f2a30" stroke-width="1.5"/><rect x="42" y="18" width="12" height="8" fill="#9cc3d6" stroke="#1f2a30" stroke-width="1"/>',
    dormerShed: '<path d="M8 26 50 6 92 26" fill="none" stroke="#9b5a43" stroke-width="3"/><path d="M32 26v-8l30-5v13" fill="#efe9e1" stroke="#1f2a30" stroke-width="1.5"/><rect x="38" y="17" width="16" height="9" fill="#9cc3d6" stroke="#1f2a30" stroke-width="1"/>',
  };
  return `<svg viewBox="0 0 100 30" aria-hidden="true">${icons[key] || ''}</svg>`;
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

function atticRoomLine(s) {
  const L = editor.level;
  if (!M.isAttic(L)) return `${fmt(s.area, 1)} m² habitables (hors murs)`;
  const el = B.buildElements(store.project).elements.find((e) => e.kind === 'space' && e.room?.id === s.room.id);
  if (el?.areaHabitable === undefined) return `${fmt(s.area, 1)} m² au sol`;
  return `${fmt(el.area, 1)} m² au sol, dont ${fmt(el.areaHabitable, 1)} m² habitables (hauteur ≥ 1,80 m)`;
}

// Menuiserie d'une ouverture : vantaux, volets battants, petits bois
function joineryFields(o, wall) {
  const cat = OPENING_TYPES[o.type] || {};
  if (cat.operation === 'sectional') return '';
  const leaves = Number.isFinite(o.leaves) ? o.leaves : (cat.leaves ?? (o.width >= 0.8 ? 2 : 1));
  const options = o.kind === 'door' ? [1, 2] : [1, 2, 3];
  const exterior = WALL_TYPES[wall?.type]?.category === 'exterior';
  const glazed = o.kind === 'window' && !cat.sliding;
  return `
    <div class="grid2">
      <label><span class="field-label">Vantaux</span>
        <select data-prop="op-leaves">${options.map((n) => `<option value="${n}" ${n === leaves ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${glazed ? `<label><span class="field-label">Petits bois</span>
        <select data-prop="op-bars"><option value="no" ${o.bars ? '' : 'selected'}>Non</option><option value="yes" ${o.bars ? 'selected' : ''}>Oui</option></select></label>` : ''}
    </div>
    ${glazed && exterior ? `<label class="field"><span class="field-label">Volets battants</span>
      <select data-prop="op-shutters">${Object.entries(SHUTTER_MODES).map(([k, v]) => `<option value="${k}" ${k === (o.shutters || 'none') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>` : ''}`;
}

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
  if (sel.type === 'equipment') {
    const item = (L.equipment || []).find((x) => x.id === sel.id);
    return item ? { ...sel, item } : null;
  }
  if (sel.type === 'balcony') {
    const item = (L.balconies || []).find((x) => x.id === sel.id);
    return item ? { ...sel, item } : null;
  }
  if (['tree', 'parking', 'hedge', 'siteSurface'].includes(sel.type)) {
    const S = store.project.site;
    const list = { tree: S.trees, parking: S.parkings, hedge: S.hedges, siteSurface: S.surfaces }[sel.type];
    const item = list.find((x) => x.id === sel.id);
    return item ? { ...sel, item } : null;
  }
  if (sel.type === 'siteBoundary') return store.project.site.boundary.length >= 3 ? { ...sel, item: store.project.site.boundary } : null;
  if (sel.type === 'stair') {
    const item = (L.stairs || []).find((x) => x.id === sel.id);
    return item ? { ...sel, item, layout: stairLayout(item, L.height, store.project.settings.slabThickness) } : null;
  }
  if (sel.type === 'terrace') {
    const tr = B.levelTerraces(store.project, editor.levelIndex).find((x) => x.key === sel.id);
    return tr ? { ...sel, terrace: tr } : null;
  }
  if (sel.type === 'roofitem') {
    const body = store.project.bodies.find((b) => b.id === sel.bodyId);
    const item = body?.roofItems?.find((it) => it.id === sel.id);
    if (!item) return null;
    const info = B.roofOpenings(store.project, L, body).find((o) => o.item.id === item.id);
    return { ...sel, body, item, info };
  }
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

const stairCountField = (label, field, value, min = 0, max = STAIR_LIMITS.flight) => `
  <label class="field"><span class="field-label">${label}</span><input type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${value}" data-prop="stair-${field}" /></label>`;

const colorScopeBody = () => (ui.colorScope && ui.colorScope !== 'project' ? M.bodyById(store.project, ui.colorScope) : null);

// Réglages du corps actif, disponibles depuis n'importe quelle étape
function bodyPanel() {
  const p = store.project;
  const b = activeBody();
  const L = editor.level;
  const topIdx = M.bodyTopLevelIndex(p, b.id);
  return `
    <section>
      <h2>Corps : ${esc(b.name)}</h2>
      <p class="sub">${roomCountOf(b.id)} pièce${roomCountOf(b.id) > 1 ? 's' : ''}${topIdx >= 0 ? `, couvert au sommet de ${esc(p.levels[topIdx].name)}` : ', aucune pièce fermée'}</p>
      ${p.bodies.length > 1 ? `<label class="field"><span class="field-label">Corps actif</span>
        <select data-field="active-body">${p.bodies.map((x) => `<option value="${x.id}" ${x.id === b.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span class="field-label">Nom</span><input type="text" value="${esc(b.name)}" data-field="body-name" /></label>
      <div class="grid2">
        <label><span class="field-label">Altitude du sol</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(b.elevation)}" data-field="body-elevation" /></span></label>
        <label><span class="field-label">Hauteur des murs</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${b.height ? fmt(b.height) : ''}" placeholder="${fmt(L.height)}" data-field="body-height" /></span></label>
      </div>
      <label class="check"><input type="checkbox" data-field="body-ceiling" ${b.ceiling ? 'checked' : ''} /> Plafond sous la toiture</label>
      ${b.ceiling ? `<label class="field"><span class="field-label">Épaisseur du plafond</span><span class="unit" data-unit="m"><input type="text" inputmode="decimal" value="${fmt(b.ceilingThickness || 0.15)}" data-field="body-ceiling-thickness" /></span></label>` : ''}
      <label class="field"><span class="field-label">Toiture</span>
        <select data-field="body-roof-type">
          <option value="none" ${b.roof.enabled ? '' : 'selected'}>Aucune</option>
          ${Object.entries(ROOF_TYPES).map(([k, label]) => `<option value="${k}" ${b.roof.enabled && b.roof.type === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label>
    </section>`;
}

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
      <section><p class="sub">Sélectionnez un mur, un angle, une ouverture ou une pièce sur le plan pour modifier ses valeurs.</p></section>
      ${bodyPanel()}
      <section>
        <h2>Couleurs</h2>
        <label class="field"><span class="field-label">Appliquer à</span>
          <select data-field="color-scope">
            <option value="project" ${ui.colorScope === 'project' ? 'selected' : ''}>Tout le projet</option>
            ${p.bodies.map((b) => `<option value="${b.id}" ${ui.colorScope === b.id ? 'selected' : ''}>${esc(b.name)} seulement</option>`).join('')}
          </select></label>
        ${Object.entries(COLOR_LABELS).map(([k, label]) => `
          <label class="colorline"><span>${esc(label)}</span><input type="color" value="${colorsOf(p, colorScopeBody())[k]}" data-color="${k}" /></label>`).join('')}
        <button class="btn ghost block" data-color-reset="1">Rétablir ${ui.colorScope === 'project' ? "les couleurs d'origine" : 'les couleurs du projet'}</button>
      </section>`;
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
      ${joineryFields(o, s.wall)}
      ${o.kind === 'door' && OPENING_TYPES[o.type]?.operation !== 'sectional' ? '<div class="row"><button class="btn" data-act="op-flip-side">Inverser le côté</button><button class="btn" data-act="op-flip-hinge">Inverser le sens</button></div>' : ''}
      ${OPENING_TYPES[o.type]?.operation === 'sectional' ? '<div class="row"><button class="btn" data-act="op-flip-side">Relevage de l\'autre côté</button></div>' : ''}
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'node') {
    el.innerHTML = `
      <h2>Angle</h2><p class="sub">Point de jonction des murs</p>
      <div class="grid2">${numField('X', 'node-x', s.point[0])}${numField('Y', 'node-y', -s.point[1])}</div>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer l'angle et ses murs</button></section>`;
  } else if (s.type === 'siteBoundary') {
    const b = s.item;
    const per = b.reduce((a, p, i) => a + G.dist(p, b[(i + 1) % b.length]), 0);
    el.innerHTML = `
      <h2>Parcelle</h2><p class="sub">Terrain du projet (IfcSite)</p>
      <div class="stat"><span>Surface</span><b>${fmt(Math.abs(G.polygonArea(b)), 0)} m²</b></div>
      <div class="stat"><span>Périmètre</span><b>${fmt(per, 1)} m</b></div>
      <p class="sub">Glissez le bord de la parcelle pour la déplacer.</p>
      <div class="row"><button class="btn" data-site-tool="boundary">Retracer</button></div>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'siteSurface') {
    const sf = s.item;
    el.innerHTML = `
      <h2>${esc(SITE_SURFACES[sf.type]?.label || 'Surface')}</h2><p class="sub">${fmt(Math.abs(G.polygonArea(sf.poly)), 1)} m²</p>
      <label class="field"><span class="field-label">Type</span>
        <select data-prop="site-type">${Object.entries(SITE_SURFACES).map(([k, c]) => `<option value="${k}" ${k === sf.type ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
      <p class="sub">Glissez la surface pour la déplacer.</p>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'parking') {
    const pk = s.item;
    el.innerHTML = `
      <h2>Place de stationnement</h2><p class="sub">Espace extérieur de type PARKING</p>
      <div class="grid2">${numField('Largeur', 'site-width', pk.width)}${numField('Longueur', 'site-depth', pk.depth)}</div>
      ${numField('Orientation', 'site-rotation', pk.rotation || 0, '°')}
      <p class="sub"><kbd>R</kbd> : pivoter de 90°, <kbd>Maj</kbd>+<kbd>R</kbd> : de 15°.</p>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'tree') {
    const t = s.item;
    el.innerHTML = `
      <h2>${esc(TREE_KINDS[t.kind || 'deciduous'])}</h2><p class="sub">Élément végétal (IfcGeographicElement)</p>
      <label class="field"><span class="field-label">Essence</span>
        <select data-prop="site-kind">${Object.entries(TREE_KINDS).map(([k, v]) => `<option value="${k}" ${k === (t.kind || 'deciduous') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <div class="grid2">${numField('Hauteur', 'site-height', t.height)}${numField('Diamètre du houppier', 'site-diameter', t.diameter)}</div>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'hedge') {
    const hg = s.item;
    const len = hg.points.slice(1).reduce((a, p, i) => a + G.dist(hg.points[i], p), 0);
    el.innerHTML = `
      <h2>Haie</h2><p class="sub">${fmt(len, 1)} m de long</p>
      <div class="grid2">${numField('Hauteur', 'site-height', hg.height)}${numField('Épaisseur', 'site-width', hg.width)}</div>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'stair') {
    const st = s.item, i = s.layout.info;
    const turning = isTurningStair(st);
    const above = store.project.levels[editor.levelIndex + 1];
    el.innerHTML = `
      <h2>Escalier ${esc((STAIR_TYPES[st.type] || STAIR_TYPES.straight).toLowerCase())}</h2>
      <p class="sub">De ${esc(L.name)} à ${esc(above?.name || "l'étage du dessus (à créer)")}, ${fmt(L.height)} m à monter</p>
      <div class="stat"><span>Marches</span><b>${i.risers} hauteurs de ${fmt(i.riser * 100, 1)} cm</b></div>
      <div class="stat"><span>Giron droit</span><b>${fmt(i.going * 100, 1)} cm</b></div>
      ${st.type === 'winder' ? `<div class="stat"><span>Giron au milieu du tournant</span><b>${fmt(i.winderGoing * 100, 1)} cm</b></div>` : ''}
      <div class="stat"><span>2 h + g (volées droites)</span><b>${fmt(i.blondel * 100, 1)} cm</b></div>
      <div class="stat"><span>Emprise au sol</span><b>${fmt(i.run[0])} × ${fmt(i.run[1])} m</b></div>
      <section>
        <label class="field"><span class="field-label">Forme</span>
          <select data-prop="stair-type">${Object.entries(STAIR_TYPES).map(([k, v]) => `<option value="${k}" ${k === st.type ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        ${numField('Largeur', 'stair-width', i.width)}
        <label class="field"><span class="field-label">Main courante</span>
          <select data-prop="stair-rail">${Object.entries(STAIR_RAILS).map(([k, v]) => `<option value="${k}" ${k === (st.rail || 'inner') ? 'selected' : ''}>${esc(isTurningStair(st) ? v : { inner: 'Un côté (F pour changer)', outer: "L'autre côté", both: 'Des deux côtés' }[k])}</option>`).join('')}</select></label>
        ${turning ? `<div class="grid2">
          ${stairCountField('Marches avant le virage', 'flight1', i.flights[0])}
          ${stairCountField('Marches après le virage', 'flight2', i.flights[1])}
        </div>
        ${st.type === 'winder' ? stairCountField('Marches dans le tournant', 'winderSteps', i.turnSteps, 2, STAIR_LIMITS.winders) : ''}
        <p class="sub">${i.flights[0]} avant + ${st.type === 'winder' ? `${i.turnSteps} tournantes` : '1 palier'} + ${i.flights[1]} après + l'arrivée à l'étage = ${i.risers} hauteurs. Modifier une volée conserve le nombre de marches de l'autre. La hauteur de marche s'adapte.</p>
        <button class="btn" data-act="stair-auto">Répartition automatique</button>` : ''}
        ${st.type === 'winder' ? '<p class="sub">Marches en éventail autour du coin intérieur. Le giron tournant est mesuré au milieu de la largeur.</p>' : ''}
        <div class="row">
          <button class="btn" data-act="stair-rotate">Pivoter <kbd>R</kbd></button>
          ${turning ? '<button class="btn" data-act="stair-flip">Virer de l\'autre côté <kbd>F</kbd></button>' : ''}
        </div>
        ${i.width < 0.8 ? '<p class="note">Largeur inférieure à 0,80 m : passage étroit pour un escalier principal.</p>' : ''}
        ${i.riser < 0.14 || i.riser > 0.20 || i.blondel < 0.60 || i.blondel > 0.66 ? '<p class="note">Cette répartition donne des marches très basses ou très hautes, ou un pas inconfortable. Ajustez les nombres de marches.</p>' : ''}
        <p class="sub">Glissez l'escalier pour le déplacer. La trémie et son garde-corps suivent.</p>
      </section>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'balcony') {
    const b = s.item;
    const wall = L.walls.find((w2) => w2.id === b.wallId);
    const g = B.balconyGeometry(b);
    const facing = wall && wall.openings.some((o) => {
      const a = L.nodes[wall.a], bb = L.nodes[wall.b];
      const t = G.projectOnSegment([b.x, b.y], a, bb).t * G.dist(a, bb);
      return (o.type === 'frenchWindow' || o.type === 'bay' || o.kind === 'door') && Math.abs(o.offset - t) < (b.width + o.width) / 2;
    });
    el.innerHTML = `
      <h2>Balcon en saillie</h2><p class="sub">${fmt(b.width * b.depth, 1)} m², dessus au niveau du plancher</p>
      <div class="grid2">${numField('Largeur', 'bal-width', b.width)}${numField('Avancée', 'bal-depth', b.depth)}</div>
      <div class="grid2">${numField('Épaisseur', 'bal-thickness', b.thickness)}${numField('Hauteur garde-corps', 'bal-railingHeight', b.railingHeight)}</div>
      <label class="field"><span class="field-label">Garde-corps</span>
        <select data-prop="bal-railing">${Object.entries(RAILING_TYPES).map(([k, v]) => `<option value="${k}" ${k === b.railing ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      ${facing ? '' : `<p class="note">Aucune porte ne donne sur ce balcon.</p><button class="btn block" data-act="balcony-window">Ajouter une porte-fenêtre en face</button>`}
      <p class="sub">Glissez le balcon pour le déplacer le long de sa façade.</p>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
    void g;
  } else if (s.type === 'terrace') {
    const t = L.terrace || { mode: 'terrace', railing: 'glass', railingHeight: 1 };
    const lower = store.project.levels[editor.levelIndex - 1];
    el.innerHTML = `
      <h2>${t.mode === 'roof' ? 'Toiture-terrasse' : 'Terrasse'}</h2>
      <p class="sub">${fmt(s.terrace.area, 1)} m² : dessus de ${esc(lower?.name || "l'étage inférieur")} non couvert par ${esc(L.name)}</p>
      <label class="field"><span class="field-label">Usage</span>
        <select data-prop="ter-mode">
          <option value="terrace" ${t.mode !== 'roof' ? 'selected' : ''}>Terrasse accessible (garde-corps)</option>
          <option value="roof" ${t.mode === 'roof' ? 'selected' : ''}>Toiture-terrasse (non accessible)</option>
        </select></label>
      ${t.mode !== 'roof' ? `
      <label class="field"><span class="field-label">Garde-corps</span>
        <select data-prop="ter-railing">${Object.entries(RAILING_TYPES).map(([k, v]) => `<option value="${k}" ${k === t.railing ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      ${numField('Hauteur du garde-corps', 'ter-railingHeight', t.railingHeight || 1)}` : ''}
      <p class="sub">La terrasse suit les murs : déplacez les façades de ${esc(L.name)} pour la modifier.</p>`;
  } else if (s.type === 'equipment') {
    const it = s.item;
    const cat = EQUIPMENT_TYPES[it.type] || { label: 'Équipement' };
    const room = M.roomAt(store.project, L, [it.x, it.y]);
    el.innerHTML = `
      <h2>${esc(cat.label)}</h2><p class="sub">${room?.room ? `Dans : ${esc(room.room.name)}` : 'Équipement'}</p>
      <div class="grid2">${numField('Largeur', 'eq-width', it.width)}${numField('Profondeur', 'eq-depth', it.depth)}</div>
      <div class="grid2">${numField('Hauteur', 'eq-height', it.height)}${numField('Hauteur de pose', 'eq-zOffset', it.zOffset || 0)}</div>
      ${numField('Rotation', 'eq-rotation', it.rotation || 0, '°')}
      <div class="row"><button class="btn" data-act="eq-rotate" data-deg="-90">Pivoter à gauche</button><button class="btn" data-act="eq-rotate" data-deg="90">Pivoter à droite</button></div>
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'roofitem' && ROOF_OPENINGS[s.item.type]?.kind === 'dormer') {
    const it = s.item;
    const preset = ROOF_OPENINGS[it.type];
    const fv = s.info?.floorValues || { eave: it.eave ?? preset.eave, winSill: it.winSill ?? preset.winSill, winHeight: it.winHeight ?? preset.winHeight };
    el.innerHTML = `
      <h2>${esc(preset.label)}</h2><p class="sub">Sur la toiture de ${esc(s.body.name)}. Hauteurs mesurées depuis le plancher.</p>
      <div class="grid2">
        ${numField('Largeur', 'sky-width', it.width ?? preset.width)}
        ${numField("Hauteur d'égout", 'sky-eave', fv.eave)}
      </div>
      <div class="grid2">
        ${preset.dormer === 'shed' ? numField('Profondeur', 'sky-depth', it.depth ?? preset.depth) : numField('Pente du toit', 'sky-pitch', it.pitch ?? preset.pitch, '°')}
        ${numField('Retrait depuis l\'égout', 'sky-setback', it.setback ?? preset.setback)}
      </div>
      <div class="grid2">
        ${numField('Hauteur de baie', 'sky-winheight', fv.winHeight)}
        ${numField('Allège de la baie', 'sky-winsill', fv.winSill)}
      </div>
      ${fv.reduced ? `<p class="note">La baie est limitée à ${fmt(fv.windowHeight)} m par la hauteur d'égout : remontez l'égout pour obtenir ${fmt(fv.winHeight)} m.</p>` : ''}
      ${fv.raised ? `<p class="note">${fv.flush
        ? `L'allège ne peut pas descendre sous le haut de la jambette : elle est à ${fmt(fv.winSill)} m.`
        : `Lucarne en retrait : la couverture passe devant, l'allège est remontée à ${fmt(fv.winSill)} m pour rester visible. Ramenez le retrait à ${fmt(store.project.bodies.find((b) => b.id === s.body.id)?.roof?.overhang ?? 0.4)} m pour poser la lucarne à l'aplomb de la façade.`}</p>` : ''}
      <p class="sub">${fv.flush ? "À l'aplomb de la façade : l'égout est interrompu devant la lucarne." : 'En retrait dans la pente : la couverture passe devant la lucarne.'}</p>
      ${s.info?.ok ? '' : `<p class="note">Lucarne non construite : ${esc(s.info?.reason || 'hors toiture')}. Ajustez ses dimensions ou sa position.</p>`}
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'roofitem') {
    const it = s.item;
    const real = s.info?.ok ? fmt(s.info.sillZ - s.info.floorZ) : null;
    el.innerHTML = `
      <h2>Fenêtre de toit</h2><p class="sub">Sur la toiture de ${esc(s.body.name)}</p>
      <div class="grid2">
        ${numField('Largeur', 'sky-width', it.width)}
        ${numField('Hauteur (sur la pente)', 'sky-height', it.height)}
      </div>
      ${numField("Allège au-dessus du plancher", 'sky-sill', it.sill)}
      ${real ? `<p class="sub">Allège obtenue : ${real} m${s.info.clamped ? ". La valeur demandée sort du pan ; la fenêtre est placée au plus près." : ''}</p>${aboveCeiling(s) ? '<p class="note">Cette fenêtre donne au-dessus du plafond de ce corps : elle éclaire les combles, pas la pièce. Décochez « Plafond sous la toiture » ou baissez l\'allège.</p>' : ''}` : `<p class="note">Fenêtre non construite : ${esc(s.info?.reason || 'hors toiture')}. Ajustez ses dimensions ou sa position.</p>`}
      <section><button class="btn danger block" data-act="delete-selection">Supprimer <kbd>Suppr</kbd></button></section>`;
  } else if (s.type === 'room') {
    el.innerHTML = `
      <h2>Pièce</h2><p class="sub">${atticRoomLine(s)}</p>
      <label class="field"><span class="field-label">Nom</span><input type="text" value="${esc(s.room.name)}" data-prop="room-name" /></label>
      <div class="chips">${ROOM_NAMES.map((n) => `<button class="chip" data-room-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <label class="field"><span class="field-label">Corps de bâtiment</span>
        <select data-prop="room-body">${p.bodies.map((x) => `<option value="${x.id}" ${x.id === (s.room.bodyId || p.bodies[0].id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`;
  }
}

function applyProp(prop, raw) {
  const s = findSelection();
  if (!s) return;
  const L = editor.level;
  const value = parseNum(raw);
  const levelId = L.id;
  const lv = (pr) => pr.levels.find((l) => l.id === levelId);
  const needNum = !['wall-type', 'room-name', 'room-body', 'bal-railing', 'ter-mode', 'ter-railing', 'stair-type', 'stair-rail', 'site-type', 'site-kind', 'op-shutters', 'op-bars'].includes(prop);
  if (prop.startsWith('site-')) {
    const key = prop.slice(5);
    const text = key === 'type' || key === 'kind';
    if (!text && !(key === 'rotation' ? Number.isFinite(value) : value > 0)) { toast('Valeur invalide.', 'warn'); renderInspector(); return; }
    store.commit('Modifier les abords', (pr) => {
      const S = pr.site;
      const list = { tree: S.trees, parking: S.parkings, hedge: S.hedges, siteSurface: S.surfaces }[s.type];
      const it = list?.find((x) => x.id === s.id);
      if (!it) return false;
      if (key === 'type' && SITE_SURFACES[raw]) it.type = raw;
      else if (key === 'kind' && TREE_KINDS[raw]) it.kind = raw;
      else if (key === 'rotation') it.rotation = ((value % 360) + 360) % 360;
      else if (!text) it[key] = value;
      return true;
    });
    return;
  }
  if (prop.startsWith('stair-')) {
    const key = prop.slice(6);
    const flightCount = key === 'flight1' || key === 'flight2';
    const invalid = key === 'type' ? !Object.hasOwn(STAIR_TYPES, raw)
      : key === 'rail' ? !Object.hasOwn(STAIR_RAILS, raw)
        : (!Number.isFinite(value) || (flightCount ? value < 0 : value <= 0));
    if (invalid) {
      toast('Valeur invalide.', 'warn'); renderInspector(); return;
    }
    store.commit("Modifier l'escalier", (pr) => {
      const st = (pr.levels.find((l) => l.id === L.id).stairs || []).find((x) => x.id === s.id);
      if (!st) return false;
      if (key === 'type') st.type = raw;
      if (key === 'width') st.width = Math.max(0.6, Math.min(2.5, value));
      if (key === 'rail') st.rail = STAIR_RAILS[raw] ? raw : 'inner';
      if (flightCount || key === 'winderSteps') {
        // Figer les deux valeurs affichées avant de modifier celle demandée.
        [st.flight1, st.flight2] = s.layout.info.flights;
        st[key] = Math.max(key === 'winderSteps' ? 2 : 0, Math.min(key === 'winderSteps' ? STAIR_LIMITS.winders : STAIR_LIMITS.flight, Math.round(value)));
      }
      return true;
    });
    return;
  }
  if (prop.startsWith('bal-')) {
    const key = prop.slice(4);
    const text = ['railing'].includes(key);
    if (!text && !(value > 0)) { toast('Valeur invalide.', 'warn'); renderInspector(); return; }
    store.commit('Modifier un balcon', (pr) => {
      const b = (pr.levels.find((l) => l.id === L.id).balconies || []).find((x) => x.id === s.id);
      if (!b) return false;
      b[key] = text ? raw : value;
      return true;
    });
    return;
  }
  if (prop.startsWith('ter-')) {
    const key = prop.slice(4);
    const text = ['mode', 'railing'].includes(key);
    if (!text && !(value > 0)) { toast('Valeur invalide.', 'warn'); renderInspector(); return; }
    store.commit('Régler la terrasse', (pr) => {
      const lv = pr.levels.find((l) => l.id === L.id);
      lv.terrace = { ...(lv.terrace || {}), [key]: text ? raw : value };
    });
    return;
  }
  if (prop.startsWith('eq-')) {
    const key = prop.slice(3);
    if (!Number.isFinite(value) || (['width', 'depth', 'height'].includes(key) && value < 0.05) || (key === 'zOffset' && value < 0)) {
      toast('Valeur invalide.', 'warn'); renderInspector(); return;
    }
    store.commit('Modifier un équipement', (pr) => {
      const it = (pr.levels.find((l) => l.id === L.id).equipment || []).find((x) => x.id === s.id);
      if (!it) return false;
      it[key] = key === 'rotation' ? ((value % 360) + 360) % 360 : value;
      return true;
    });
    return;
  }
  if (prop.startsWith('sky-')) {
    if (!(value >= 0) || (prop !== 'sky-setback' && prop !== 'sky-winsill' && !(value > 0))) { toast('Valeur invalide.', 'warn'); renderInspector(); return; }
    store.commit('Modifier une fenêtre de toit', (pr) => {
      const body = M.bodyById(pr, s.bodyId);
      const it = body.roofItems.find((x) => x.id === s.id);
      if (prop === 'sky-width') it.width = Math.max(0.3, value);
      if (prop === 'sky-height') it.height = Math.max(0.3, value);
      if (prop === 'sky-sill') it.sill = value;
      if (['sky-eave', 'sky-winsill', 'sky-winheight'].includes(prop) && it.ref !== 'floor') {
        const fv = s.info?.floorValues;
        if (fv) { it.eave = fv.eave; it.winSill = fv.winSill; it.winHeight = fv.winHeight; }
        it.ref = 'floor';
      }
      if (prop === 'sky-eave') it.eave = Math.max(0.8, value);
      if (prop === 'sky-pitch') it.pitch = Math.min(70, Math.max(5, value));
      if (prop === 'sky-depth') it.depth = Math.max(0.6, value);
      if (prop === 'sky-setback') it.setback = Math.max(0, value);
      if (prop === 'sky-winheight') it.winHeight = Math.max(0.3, value);
      if (prop === 'sky-winsill') it.winSill = Math.max(0, value);
    });
    return;
  }
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
      case 'op-leaves': op.leaves = Math.max(1, Math.min(3, Math.round(value))); break;
      case 'op-shutters': op.shutters = SHUTTER_MODES[raw] ? raw : 'none'; break;
      case 'op-bars': op.bars = raw === 'yes'; break;
      case 'op-height': if (value < 0.2) return false; op.height = Math.min(value, M.wallHeight(pr, level) - op.sill); break;
      case 'op-sill': if (value < 0) return false; op.sill = Math.min(value, M.wallHeight(pr, level) - 0.2); op.height = Math.min(op.height, M.wallHeight(pr, level) - op.sill); break;
      case 'op-offset': op.offset = value + op.width / 2; M.clampOpenings(level); break;
      case 'node-x': level.nodes[s.id] = [value, level.nodes[s.id][1]]; M.clampOpenings(level); break;
      case 'node-y': level.nodes[s.id] = [level.nodes[s.id][0], -value]; M.clampOpenings(level); break;
      case 'room-body': {
        const room = level.rooms.find((r) => r.id === s.room.id);
        room.bodyId = raw;
        break;
      }
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

function renderBodyBar() {
  const p = store.project;
  const el = $('#bodyBar');
  if (!el) return;
  el.innerHTML = `<span>Corps</span><select id="bodySelect" aria-label="Corps de bâtiment actif">
    ${p.bodies.map((b) => `<option value="${b.id}" ${b.id === p.activeBodyId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
  </select>`;
}

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
      <label class="check"><input type="checkbox" name="rooms" checked /> Noms des pièces</label>
      <label class="check"><input type="checkbox" name="equipment" /> Équipements (cuisine, sanitaires, mobilier)</label>`,
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
  ui.step = 'plan';
  renderSteps();
  toast(`Niveau ${editor.level.name} créé. Importez son plan : il sera mis à l'échelle et calé sur ces murs automatiquement.`);
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
    const idx = pr.levels.findIndex((l) => l.id === levelId);
    const prev = L.plan;
    // Plan calé le plus proche en dessous : c'est presque toujours le même dossier,
    // donc la même échelle. On la reprend d'office ; « Refaire l'échelle » reste possible.
    let source = null;
    for (let i = idx - 1; i >= 0 && !source; i--) if (pr.levels[i].plan?.calibrated) source = pr.levels[i];
    const ref = prev?.calibrated ? prev : source?.plan || null;
    // un PDF rendu à une autre densité (autre fichier) garde la même échelle papier
    let scale = ref?.calibrated ? ref.scale : 0.01;
    if (ref?.calibrated && ref.ptPerPx && meta.ptPerPx) scale = ref.scale * (meta.ptPerPx / ref.ptPerPx);
    L.plan = {
      assetId,
      width: image.width,
      height: image.height,
      x: ref ? ref.x : 0,
      y: ref ? ref.y : 0,
      scale,
      rotation: ref?.rotation || 0,
      opacity: 0.55,
      calibrated: !!ref?.calibrated,
      scaleFrom: !prev?.calibrated && source ? source.name : null,
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
    if (editor.level.plan?.calibrated && alignReference()) await runAutoAlign();
  } catch (err) {
    console.error(err);
    toast(`Import impossible : ${err.message}`, 'warn');
  }
}

// ─── Superposition des plans d'étage ─────────────────────────────────────────

// Murs sur lesquels caler le plan : ceux de l'étage lui-même s'il a été dupliqué,
// sinon ceux de l'étage du dessous. Les murs extérieurs se superposent d'un étage à l'autre.
function alignReference() {
  const L = editor.level;
  if (L.walls.length >= 3) return { level: L, label: `les murs de ${L.name}` };
  const below = editor.levelBelow;
  if (below && below.walls.length >= 3) return { level: below, label: `les murs de ${below.name}` };
  return null;
}

async function runAutoAlign() {
  const L = editor.level;
  const ref = alignReference();
  if (!L.plan || !ref) { toast("Aucun mur de référence : tracez d'abord l'étage du dessous.", 'warn'); return; }
  const img = await IO.loadImage(store.project.assets[L.plan.assetId]);
  const done = busy('Superposition du plan…');
  let result = null;
  try {
    await new Promise((r) => setTimeout(r, 30)); // laisse le temps d'afficher le message
    const below = editor.levelBelow;
    result = autoAlignPlan(L.plan, img, referenceWalls(ref.level), { preferRotation: below?.plan?.rotation ?? L.plan.rotation ?? 0 });
  } finally { done(); }
  if (!result) { toast('Superposition impossible sur ce plan.', 'warn'); return; }
  const levelId = L.id;
  store.commit('Superposer le plan', (pr) => {
    const plan = pr.levels.find((l) => l.id === levelId).plan;
    applyAlignment(plan, result);
  });
  ui.alignBanner = { levelId, confidence: result.confidence, label: ref.label };
  renderAlignBanner();
}

function renderAlignBanner() {
  const el = $('#alignBanner');
  const b = ui.alignBanner;
  if (!b || b.levelId !== editor.levelId || !editor.level.plan) { el.hidden = true; return; }
  const sure = b.confidence >= 0.45;
  const adjusting = editor.tool === 'planAdjust';
  el.hidden = false;
  el.innerHTML = `
    <div>
      <b>${adjusting ? 'Ajustez le plan' : sure ? 'Plan superposé' : 'Superposition incertaine'}</b>
      <span>${adjusting
        ? "Glissez l'image pour la déplacer, la poignée ronde pour la tourner. Flèches : 1 cm, Maj + flèches : 10 cm."
        : sure ? `Calé sur ${esc(b.label)}. Vérifiez que les murs tombent sur ceux du plan.`
          : `Le plan ne ressemble pas assez à ${esc(b.label)}. Ajustez-le à la main.`}</span>
    </div>
    <div class="row">
      ${adjusting ? `<label class="check"><input type="checkbox" data-field="plan-scale-lock" ${ui.scaleUnlocked ? '' : 'checked'} /> Échelle verrouillée</label>` : ''}
      <button class="btn ghost" data-act="align-auto">Recaler</button>
      ${adjusting ? '' : `<button class="btn ${sure ? '' : 'primary'}" data-act="align-adjust">Ajuster à la main</button>`}
      <button class="btn ${sure || adjusting ? 'primary' : ''}" data-act="align-ok">${adjusting ? 'Terminé' : "C'est bon"}</button>
    </div>`;
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
  const hasWork = store.project.levels.some((l) => l.walls.length || l.plan) || (store.project.site?.surfaces?.length);
  const choice = await modal({
    title: 'Commencer un nouveau projet ?',
    body: hasWork
      ? `<p>« ${esc(store.project.name)} » sera remplacé par un projet vide. Enregistrez-le d'abord si vous souhaitez le garder : vous pourrez le rouvrir depuis le menu Projet.</p>`
      : '<p>Le projet actuel est vide : il sera simplement remis à zéro.</p>',
    actions: hasWork
      ? [{ label: 'Annuler', id: false }, { label: 'Recommencer sans enregistrer', kind: 'ghost', id: 'discard' }, { label: 'Enregistrer puis recommencer', kind: 'primary', id: 'save', default: true }]
      : [{ label: 'Annuler', id: false }, { label: 'Nouveau projet', kind: 'primary', id: 'discard', default: true }],
  });
  if (!choice) return;
  if (choice === 'save') saveProjectFile();
  loadProject(M.newProject('Ma maison'));
  store.clearHistory?.();
  ui.exported = false;
  ui.alignBanner = null;
  toast('Nouveau projet : importez un plan ou tracez directement vos murs.');
}

// ─── Rendu global et événements ───────────────────────────────────────────────

function renderAll() {
  const p = store.project;
  renderAlignBanner();
  if (document.activeElement !== $('#projectName')) $('#projectName').value = p.name;
  renderLevelTabs();
  renderBodyBar();
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
  if (d.body) { store.project.activeBodyId = d.body; ui.roofBodyId = d.body; renderAll(); return; }
  if (d.skylight) { setTool('select'); editor.select({ type: 'roofitem', id: d.skylight, bodyId: d.skylightBody }); renderSteps(); return; }
  if (d.mode && t.closest('#viewMode')) { setViewMode(d.mode); return; }
  if (d.wallType) { editor.wallType = d.wallType; setTool('wall'); return; }
  if (d.trace) { editor.traceMode = d.trace; setTool('wall'); return; }
  if (d.opening) { editor.openingType = d.opening; setTool('opening'); return; }
  if (d.room) { setTool('select'); editor.select({ type: 'room', id: d.room }); renderSteps(); return; }
  if (d.roomName) { applyProp('room-name', d.roomName); return; }
  if (d.stairType) { editor.stairType = d.stairType; setTool('stair'); return; }
  if (d.siteTool) {
    if (editor.levelIndex !== 0) switchLevel(store.project.levels[0].id);
    const tool = d.siteTool;
    if (tool === 'parking') setTool('parking');
    else if (tool === 'hedge') setTool('hedge');
    else if (tool.startsWith('tree-')) { editor.treeKind = tool.slice(5); setTool('tree'); }
    else { editor.siteMode = tool; setTool('sitePoly'); }
    ui.step = 'site';
    renderSteps();
    return;
  }
  if (d.equipmentType) { editor.equipmentType = d.equipmentType; ui.step = 'equipment'; setTool('equipment'); return; }
  if (d.roofopening) { editor.roofOpeningType = d.roofopening; setTool('skylight'); return; }
  if (d.roof) {
    editBody(roofBody().id, 'Type de toiture', (b) => {
      b.roof.type = d.roof;
      b.roof.enabled = true;
      delete b.roof.ends; // le type choisi fixe ses extrémités (deux pignons ou deux croupes)
      if (d.roof === 'shed' && b.roof.pitch > 30) b.roof.pitch = 12;
    });
    return;
  }
  if (d.colorReset) {
    const scope = ui.colorScope;
    store.commit('Couleurs par défaut', (pr) => {
      if (scope === 'project') pr.colors = {};
      else M.bodyById(pr, scope).colors = {};
    });
    return;
  }
  const act = d.act;
  if (!act) return;
  const L = editor.level;
  const actions = {
    'import-plan': () => $('#planFile').click(),
    'remove-plan': () => store.commit('Retirer le plan', (pr) => { pr.levels.find((l) => l.id === L.id).plan = null; }),
    'tool-scale': () => setTool('scale'),
    'tool-measure': () => setTool('measure'),
    'tool-calage': () => setTool('calage'),
    'tool-align2': () => setTool('align2'),
    'tool-skylight': () => setTool('skylight'),
    'tool-balcony': () => setTool('balcony'),
    'shutters-all': () => {
      const mode = SHUTTER_MODES[d.mode] ? d.mode : 'none';
      let n = 0;
      store.commit('Volets sur toutes les fenêtres', (pr) => {
        for (const lvl of pr.levels) for (const w of lvl.walls) {
          if (WALL_TYPES[w.type]?.category !== 'exterior') continue;
          for (const op of w.openings || []) {
            if (op.kind !== 'window' || OPENING_TYPES[op.type]?.sliding) continue;
            op.shutters = mode; n++;
          }
        }
      });
      toast(n ? `Volets ${SHUTTER_MODES[mode].toLowerCase()} sur ${n} fenêtre${n > 1 ? 's' : ''}.` : 'Aucune fenêtre de façade.');
    },
    'stair-rotate': () => { if (editor.selection?.type === 'stair') editor.rotateStair(editor.selection.id, 90); },
    'stair-flip': () => { if (editor.selection?.type === 'stair') editor.flipStair(editor.selection.id); },
    'stair-auto': () => {
      const sel = findSelection();
      if (sel?.type !== 'stair') return;
      store.commit('Répartition automatique des marches', (pr) => {
        const st = pr.levels.find((l) => l.id === L.id).stairs.find((x) => x.id === sel.id);
        delete st.flight1;
        delete st.flight2;
      });
    },
    'balcony-window': () => {
      const sel = findSelection();
      if (!sel?.item) return;
      const b = sel.item;
      const wall = L.walls.find((w2) => w2.id === b.wallId) || L.walls
        .map((w2) => ({ w2, d: G.projectOnSegment([b.x, b.y], L.nodes[w2.a], L.nodes[w2.b]).d }))
        .sort((m, n) => m.d - n.d)[0]?.w2;
      if (!wall) { toast('Aucune façade trouvée derrière ce balcon.', 'warn'); return; }
      const a = L.nodes[wall.a], bb = L.nodes[wall.b];
      const offset = G.projectOnSegment([b.x, b.y], a, bb).t * G.dist(a, bb);
      const cat = OPENING_TYPES.frenchWindow;
      store.commit('Porte-fenêtre sur le balcon', (pr) => {
        const w2 = pr.levels.find((l) => l.id === L.id).walls.find((x) => x.id === wall.id);
        w2.openings.push({ id: M.uid('o'), type: 'frenchWindow', kind: cat.kind, offset, width: cat.width, height: cat.height, sill: cat.sill, side: 1, hinge: 'start' });
        M.clampOpenings(pr.levels.find((l) => l.id === L.id));
      });
      toast('Porte-fenêtre ajoutée face au balcon.');
    },
    'align-auto': () => runAutoAlign(),
    'align-adjust': () => { ui.alignBanner = ui.alignBanner || { levelId: editor.levelId, confidence: 1, label: 'le plan' }; setTool('planAdjust'); renderAlignBanner(); },
    'align-ok': () => { ui.alignBanner = null; setTool('select'); renderAlignBanner(); toast('Plan en place. Vous pouvez tracer ou modifier les murs de cet étage.'); goStep('walls'); },
    'plan-adjust': () => { ui.alignBanner = { levelId: editor.levelId, confidence: 1, label: 'le plan' }; setTool('planAdjust'); renderAlignBanner(); },
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
    'new-body': async () => {
      const sel = editor.selection?.type === 'room' ? L.rooms.find((r) => r.id === editor.selection.id) : null;
      if (!sel) return;
      const name = await modal({
        title: 'Nouveau corps de bâtiment',
        body: `<p>« ${esc(sel.name)} » et les pièces que vous y rattacherez formeront ce corps : altitude, hauteur de murs et toiture indépendantes.</p>
          <label class="field"><span class="field-label">Nom</span><input type="text" id="bodyName" value="Garage" /></label>`,
        actions: [{ label: 'Annuler', id: null }, { label: 'Créer', kind: 'primary', default: true, value: (root) => root.querySelector('#bodyName').value.trim() || 'Corps' }],
      });
      if (!name) return;
      store.commit('Nouveau corps', (pr) => {
        const source = M.bodyById(pr, pr.activeBodyId);
        const body = M.newBody(name, { ...source.roof });
        pr.bodies.push(body);
        pr.activeBodyId = body.id;
        pr.levels.find((l) => l.id === L.id).rooms.find((r) => r.id === sel.id).bodyId = body.id;
      });
      toast(`« ${name} » créé. Réglez son altitude, sa hauteur et sa toiture.`);
    },
    'assign-all': async () => {
      const b = activeBody();
      const ok = await modal({
        title: `Rattacher toutes les pièces de ${esc(L.name)} ?`,
        body: `<p>Les ${L.rooms.length} pièces de ce niveau rejoindront « ${esc(b.name)} ». Utile pour réparer un rattachement erroné. Annulable avec Ctrl+Z.</p>`,
        actions: [{ label: 'Annuler', id: false }, { label: 'Rattacher', kind: 'primary', id: true, default: true }],
      });
      if (!ok) return;
      store.commit('Rattacher les pièces', (pr) => {
        for (const r of pr.levels.find((l) => l.id === L.id).rooms) r.bodyId = b.id;
      });
    },
    'del-body': () => {
      const id = store.project.activeBodyId;
      if (store.project.bodies[0].id === id) return;
      store.commit('Supprimer un corps', (pr) => {
        const fallback = pr.bodies[0].id;
        for (const l of pr.levels) for (const r of l.rooms) if (r.bodyId === id) r.bodyId = fallback;
        pr.bodies = pr.bodies.filter((b) => b.id !== id);
        pr.activeBodyId = fallback;
      });
    },
    'eq-rotate': () => { if (editor.selection?.type === 'equipment') editor.rotateEquipment(editor.selection.id, +d.deg); },
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
  if (t.id === 'bodySelect') {
    store.project.activeBodyId = t.value;
    ui.roofBodyId = t.value;
    renderAll();
    return;
  }
  if (d.color) {
    const key = d.color, value = t.value, scope = ui.colorScope;
    if (store.gesture) store.endGesture();
    else store.commit('Changer une couleur', (pr) => applyColor(pr, scope, key, value));
    return;
  }
  if (d.prop) { applyProp(d.prop, t.value); return; }
  if (d.live === 'plan-opacity' || d.live === 'roof-pitch') {
    const levelId = editor.levelId;
    const v = +t.value;
    // on remet la valeur d'origine puis on enregistre une étape d'annulation propre
    if (store.gesture) store.endGesture();
    else store.commit('Modifier un réglage', (pr) => {
      if (d.live === 'plan-opacity') pr.levels.find((l) => l.id === levelId).plan.opacity = v;
      else M.bodyById(pr, ui.roofBodyId || pr.activeBodyId).roof.pitch = v;
    });
    return;
  }
  const field = d.field;
  if (!field) return;
  const L = editor.level;
  const v = parseNum(t.value);
  const bad = () => { toast('Valeur invalide.', 'warn'); renderSteps(); };
  switch (field) {
    case 'level-attic':
      store.commit("Type d'étage", (pr) => {
        const lv = pr.levels.find((l) => l.id === L.id);
        lv.attic = { kneeWall: 0.9, ceilingHeight: 2.5, ...(lv.attic || {}), enabled: t.value === 'attic' };
      });
      if (t.value === 'attic') toast('Étage sous toiture : la toiture repose maintenant sur des jambettes de 0,90 m.');
      break;
    case 'attic-knee':
      if (!(v >= 0 && v <= 2.5)) return bad();
      store.commit('Hauteur des jambettes', (pr) => { pr.levels.find((l) => l.id === L.id).attic.kneeWall = v; });
      break;
    case 'attic-ceiling':
      if (!(v >= 1.8 && v <= 6)) return bad();
      store.commit('Hauteur du faux plafond', (pr) => { pr.levels.find((l) => l.id === L.id).attic.ceilingHeight = v; });
      break;
    case 'level-height':
      if (!(v >= 1.8 && v <= 10)) return bad();
      store.commit("Hauteur d'étage", (pr) => { pr.levels.find((l) => l.id === L.id).height = v; });
      break;
    case 'slab':
      if (!(v >= 0.05 && v <= 1)) return bad();
      store.commit('Épaisseur des planchers', (pr) => { pr.settings.slabThickness = v; });
      break;
    case 'roof-body':
      ui.roofBodyId = t.value;
      store.project.activeBodyId = t.value;
      renderAll();
      break;
    case 'roof-enabled':
      editBody(roofBody().id, 'Toiture', (b) => { b.roof.enabled = t.checked; });
      break;
    case 'roof-overhang':
      if (!(v >= 0 && v <= 2)) return bad();
      editBody(roofBody().id, 'Débord de toiture', (b) => { b.roof.overhang = v; });
      break;
    case 'plan-scale-lock':
      ui.scaleUnlocked = !t.checked;
      editor.planScaleUnlocked = ui.scaleUnlocked;
      editor.invalidate();
      break;
    case 'roof-flip':
      editBody(roofBody().id, 'Sens du faîtage', (b) => { b.roof.ridgeFlip = t.checked; });
      break;
    case 'body-ceiling':
      editBody(activeBody().id, 'Plafond', (b) => { b.ceiling = t.checked; });
      break;
    case 'body-ceiling-thickness':
      if (!(v >= 0.02 && v <= 0.6)) return bad();
      editBody(activeBody().id, 'Épaisseur du plafond', (b) => { b.ceilingThickness = v; });
      break;
    case 'roof-footprint':
      editBody(roofBody().id, 'Emprise de la toiture', (b) => {
        b.roof.footprint = ['auto', 'rect', 'follow'].includes(t.value) ? t.value : 'auto';
        b.roof.followSetbacks = b.roof.footprint === 'follow';
      });
      break;
    case 'roof-end-min':
    case 'roof-end-max':
      editBody(roofBody().id, 'Extrémité de toiture', (b) => {
        const ends = { ...(b.roof.ends || (b.roof.type === 'hip' ? { min: 'hip', max: 'hip' } : { min: 'gable', max: 'gable' })) };
        ends[t.dataset.field === 'roof-end-min' ? 'min' : 'max'] = t.value === 'hip' ? 'hip' : 'gable';
        b.roof.ends = ends;
        // deux pignons ou deux croupes : on retombe sur les types habituels
        if (ends.min === ends.max) b.roof.type = ends.min === 'hip' ? 'hip' : 'gable';
      });
      break;
    case 'roof-thickness':
      if (!(v >= 0.05 && v <= 1)) return bad();
      editBody(roofBody().id, 'Épaisseur de toiture', (b) => { b.roof.thickness = v; });
      break;
    case 'body-name':
      if (!t.value.trim()) return bad();
      editBody(activeBody().id, 'Renommer le corps', (b) => { b.name = t.value.trim(); });
      break;
    case 'body-elevation':
      if (!(v >= -3 && v <= 3)) return bad();
      editBody(activeBody().id, 'Altitude du corps', (b) => { b.elevation = v; });
      break;
    case 'body-height':
      if (!t.value.trim()) { editBody(activeBody().id, 'Hauteur des murs', (b) => { b.height = null; }); break; }
      if (!(v >= 1.8 && v <= 10)) return bad();
      editBody(activeBody().id, 'Hauteur des murs', (b) => { b.height = v; });
      break;
    case 'active-body':
      store.project.activeBodyId = t.value;
      ui.roofBodyId = t.value;
      renderAll();
      break;
    case 'body-roof-type':
      editBody(activeBody().id, 'Toiture du corps', (b) => {
        if (t.value === 'none') { b.roof.enabled = false; return; }
        b.roof.enabled = true;
        b.roof.type = t.value;
        if (t.value === 'shed' && b.roof.pitch > 30) b.roof.pitch = 12;
      });
      break;
    case 'color-scope':
      ui.colorScope = t.value;
      renderInspector();
      break;
    case 'body-draw': {
      const id = activeBody().id;
      store.commit('Corps de tracé', (pr) => { pr.drawBodyId = t.checked ? id : null; });
      break;
    }
    default: break;
  }
});

document.addEventListener('input', (e) => {
  const d = e.target.dataset;
  if (d.color) {
    const key = d.color, value = e.target.value, scope = ui.colorScope;
    if (!store.gesture) store.beginGesture('Changer une couleur');
    store.live((pr) => applyColor(pr, scope, key, value));
    return;
  }
  if (d.live === 'plan-opacity' || d.live === 'roof-pitch') {
    const levelId = editor.levelId;
    const v = +e.target.value;
    if (!store.gesture) store.beginGesture('Modifier un réglage');
    store.live((pr) => {
      if (d.live === 'plan-opacity') pr.levels.find((l) => l.id === levelId).plan.opacity = v;
      else M.bodyById(pr, ui.roofBodyId || pr.activeBodyId).roof.pitch = v;
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
// Menu Projet : nouveau, ouvrir, enregistrer
{
  const btn = $('#projectMenuBtn'), pop = $('#projectMenu');
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); });
  pop.addEventListener('click', () => setTimeout(close, 0));
  document.addEventListener('click', (e) => { if (!e.target.closest('#projectMenuWrap')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
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
window.smelt = { store, editor, get view3d() { return view3d; }, exportIfc: () => exportIfc(store.project) };
