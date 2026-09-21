// Smelt Studio — représentation des équipements dans le plan et dans la palette.
import { EQUIPMENT_TYPES } from './equipment-catalog.js';

const ACCENT = '#e8672a';
const INK = '#1f2a30';
const SOFT = '#56626a';

export function drawEquipmentSymbol(editor, item, { alpha = 1, preview = false, selected = false } = {}) {
  const ctx = editor.ctx;
  const cat = EQUIPMENT_TYPES[item.type] || EQUIPMENT_TYPES.baseCabinet;
  const s = editor.toScreen([item.x, item.y]);
  const z = editor.view.zoom;
  const w = item.width;
  const d = item.depth;
  const angle = (item.rotation || 0) * Math.PI / 180;

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

export function equipmentIcon(type) {
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
