// Smelt Studio — import de plans (image / PDF), sauvegarde locale (IndexedDB) et téléchargements.

const PDFJS_URL = '/vendor/pdfjs/pdf.min.mjs';
const PDFJS_WORKER = '/vendor/pdfjs/pdf.worker.min.mjs';
const MAX_SIDE = 3200; // taille maximale de rendu d'une page (px)

export function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`Lecture impossible : ${file.name}`));
    r.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("L'image n'a pas pu être chargée."));
    img.src = src;
  });
}

let pdfjsPromise = null;
async function pdfjs() {
  if (!pdfjsPromise) {
    const url = PDFJS_URL;
    pdfjsPromise = import(/* @vite-ignore */ url).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfjsPromise;
}

export async function openPdf(file) {
  const lib = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  return lib.getDocument({ data }).promise;
}

// Rendu d'une page : renvoie { dataUrl, width, height, ptPerPx }
export async function renderPdfPage(pdf, pageNumber, maxSide = MAX_SIDE) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxSide / Math.max(base.width, base.height), 6);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    ptPerPx: 1 / scale,
  };
}

// ─── Sauvegarde automatique (IndexedDB) ───────────────────────────────────────

const DB = 'smelt-studio';
const STORE = 'projects';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLocal(project) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(JSON.stringify(project), 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadLocal() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('current');
    req.onsuccess = () => resolve(req.result ? JSON.parse(req.result) : null);
    req.onerror = () => reject(req.error);
  });
}

export function download(filename, data, mime = 'application/octet-stream') {
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

export function safeName(name) {
  return (name || 'projet')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '')
    .toLowerCase() || 'projet';
}
