/**
 * Rich IFC type picker — opens as a popover with category groups,
 * live search, and keyboard navigation.
 *
 * Usage:
 *   import { openTypePicker } from './ifc-type-picker.js';
 *   const newType = await openTypePicker({
 *     anchor: triggerButton,    // anchor element for positioning
 *     currentType: 'IFCWALL',   // current selection (highlighted)
 *     catalog,                  // { types, categories } from /api/ifc-catalog
 *   });
 *   // newType is the chosen type string, or null if cancelled.
 */

let activePicker = null;

export function openTypePicker({ anchor, currentType, catalog }) {
  closePicker();

  return new Promise((resolve) => {
    const types = catalog.types || [];
    const categories = catalog.categories || [];

    const overlay = document.createElement('div');
    overlay.className = 'tp-overlay';
    overlay.innerHTML = `
      <div class="tp-popover" role="dialog" aria-label="Choisir un type IFC">
        <div class="tp-header">
          <input type="text" class="tp-search" placeholder="Rechercher un type (mur, porte, lavabo…)" autocomplete="off" />
          <button type="button" class="tp-close" aria-label="Fermer">×</button>
        </div>
        <div class="tp-list" role="listbox"></div>
        <div class="tp-footer">
          <span>↑↓ naviguer · ⏎ valider · Esc fermer</span>
          <span class="tp-count"></span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const popover = overlay.querySelector('.tp-popover');
    const search = overlay.querySelector('.tp-search');
    const list = overlay.querySelector('.tp-list');
    const countEl = overlay.querySelector('.tp-count');
    const closeBtn = overlay.querySelector('.tp-close');

    // Position the popover near the anchor (or center)
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const top = Math.min(rect.bottom + 8, window.innerHeight - 480);
      const right = Math.max(window.innerWidth - rect.right, 16);
      popover.style.top = `${Math.max(16, top)}px`;
      popover.style.right = `${right}px`;
    }

    let visibleEntries = []; // flat list of currently displayed entries (in DOM order)
    let highlightIdx = 0;

    function normalize(s) {
      return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    }

    function score(entry, q) {
      const tn = normalize(entry.type);
      const ln = normalize(entry.label);
      const an = entry.aliases.map(normalize);
      if (tn === q) return 1000;
      if (tn.startsWith(q)) return 900;
      if (ln === q) return 800;
      if (ln.startsWith(q)) return 700;
      if (an.some(a => a === q)) return 600;
      if (an.some(a => a.startsWith(q))) return 500;
      if (tn.includes(q)) return 400;
      if (ln.includes(q)) return 300;
      if (an.some(a => a.includes(q))) return 200;
      return 0;
    }

    function categoryFor(key) {
      return categories.find(c => c.key === key) || { key, label: key };
    }

    function render(query) {
      const q = normalize(query);
      list.innerHTML = '';
      visibleEntries = [];

      // Filtered set
      let filtered;
      if (!q) {
        filtered = types.slice();
      } else {
        const scored = types
          .map(e => ({ e, s: score(e, q) }))
          .filter(x => x.s > 0)
          .sort((a, b) => b.s - a.s);
        filtered = scored.map(x => x.e);
      }

      // When searching, show flat list (no category groups) ordered by score.
      // When not searching, show grouped by category.
      if (q) {
        for (const entry of filtered) {
          list.appendChild(renderItem(entry));
          visibleEntries.push(entry);
        }
      } else {
        // Group by category, in catalog category order
        const byCat = new Map();
        for (const entry of filtered) {
          if (!byCat.has(entry.category)) byCat.set(entry.category, []);
          byCat.get(entry.category).push(entry);
        }
        for (const cat of categories) {
          const group = byCat.get(cat.key);
          if (!group || group.length === 0) continue;
          const header = document.createElement('div');
          header.className = 'tp-cat';
          header.textContent = cat.label;
          list.appendChild(header);
          for (const entry of group) {
            list.appendChild(renderItem(entry));
            visibleEntries.push(entry);
          }
        }
      }

      countEl.textContent = `${filtered.length} type${filtered.length > 1 ? 's' : ''}`;

      // Default highlight: the currently selected type if visible, else first
      let idx = visibleEntries.findIndex(e => e.type === currentType);
      if (idx < 0) idx = 0;
      setHighlight(idx);
    }

    function renderItem(entry) {
      const item = document.createElement('div');
      item.className = 'tp-item';
      if (entry.tier === 'unsupported') item.classList.add('tp-disabled');
      item.dataset.type = entry.type;

      const isCurrent = entry.type === currentType;
      const tierBadge = entry.tier === 'opening' ? '<span class="tp-tier" title="Recalcule Height/Width">geom</span>'
                     : entry.tier === 'unsupported' ? '<span class="tp-tier disabled" title="Non supporté">×</span>'
                     : '';

      item.innerHTML = `
        <span class="tp-radio">${isCurrent ? '●' : '○'}</span>
        <span class="tp-type">${entry.type}</span>
        <span class="tp-label">${entry.label}</span>
        ${tierBadge}
      `;

      if (entry.tier !== 'unsupported') {
        item.addEventListener('click', () => choose(entry.type));
      } else if (entry.reason) {
        item.title = entry.reason;
      }
      return item;
    }

    function setHighlight(idx) {
      if (visibleEntries.length === 0) return;
      highlightIdx = Math.max(0, Math.min(visibleEntries.length - 1, idx));
      const items = list.querySelectorAll('.tp-item');
      items.forEach(el => el.classList.remove('tp-highlight'));
      // Skip disabled items when navigating
      let skipped = 0;
      while (visibleEntries[highlightIdx]?.tier === 'unsupported' && skipped < visibleEntries.length) {
        highlightIdx = (highlightIdx + 1) % visibleEntries.length;
        skipped++;
      }
      const target = list.querySelector(`.tp-item[data-type="${visibleEntries[highlightIdx]?.type}"]`);
      if (target) {
        target.classList.add('tp-highlight');
        target.scrollIntoView({ block: 'nearest' });
      }
    }

    function choose(type) {
      const entry = types.find(t => t.type === type);
      if (!entry || entry.tier === 'unsupported') return;
      cleanup();
      resolve(type);
    }

    function cancel() {
      cleanup();
      resolve(null);
    }

    function cleanup() {
      overlay.remove();
      activePicker = null;
      document.removeEventListener('keydown', onKey, true);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight(highlightIdx + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight(highlightIdx - 1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const entry = visibleEntries[highlightIdx];
        if (entry) choose(entry.type);
        return;
      }
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cancel();
    });
    closeBtn.addEventListener('click', cancel);
    search.addEventListener('input', () => render(search.value));
    document.addEventListener('keydown', onKey, true);

    activePicker = { cleanup };

    // Initial render
    render('');
    setTimeout(() => search.focus(), 0);
  });
}

export function closePicker() {
  if (activePicker) {
    activePicker.cleanup();
    activePicker = null;
  }
}
