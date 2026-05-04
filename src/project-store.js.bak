const DB_NAME = "glb2ifc-project-store";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const LAST_PROJECT_KEY = "glb2ifc:lastProjectId";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("ifcFileName", "ifcFileName", { unique: false });
        store.createIndex("glbFileName", "glbFileName", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Impossible d’ouvrir IndexedDB."));
  });

  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Transaction IndexedDB échouée."));
    tx.onabort = () => reject(tx.error || new Error("Transaction IndexedDB annulée."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Requête IndexedDB échouée."));
  });
}

export function makeProjectId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function setLastProjectId(id) {
  if (!id) return;
  localStorage.setItem(LAST_PROJECT_KEY, id);
}

export function getLastProjectId() {
  return localStorage.getItem(LAST_PROJECT_KEY) || "";
}

export async function saveProject(project) {
  const db = await openDb();
  const now = new Date().toISOString();
  const value = {
    ...project,
    id: project.id || makeProjectId(),
    createdAt: project.createdAt || now,
    updatedAt: now,
  };

  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(value);
  await txDone(tx);
  setLastProjectId(value.id);
  return value;
}

export async function updateProject(id, patch) {
  if (!id) throw new Error("Project id manquant.");
  const current = await getProject(id);
  if (!current) throw new Error("Projet introuvable dans le stockage local du navigateur.");
  return saveProject({ ...current, ...patch, id, createdAt: current.createdAt });
}

export async function getProject(id) {
  if (!id) return null;
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  return requestResult(tx.objectStore(STORE_NAME).get(id));
}

export async function listProjects() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);

  if (typeof store.getAll === "function") {
    const all = await requestResult(store.getAll());
    return all.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  return new Promise((resolve, reject) => {
    const out = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))));
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Lecture des projets impossible."));
  });
}

export async function findProjectForIfcFile(fileName) {
  const normalized = normalizeFileBase(fileName);
  if (!normalized) return null;

  const projects = await listProjects();
  return projects.find((project) => {
    const ifcBase = normalizeFileBase(project.ifcFileName);
    const glbBase = normalizeFileBase(project.glbFileName);
    return ifcBase === normalized || glbBase === normalized;
  }) || null;
}

export function normalizeFileBase(fileName) {
  return String(fileName || "")
    .toLowerCase()
    .replace(/\.edited(?=\.)/g, "")
    .replace(/\.(ifc|ifczip|frag|glb|gltf)$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function editsMapToArray(map) {
  return [...(map || new Map()).entries()].map(([localId, edit]) => ({
    localId: Number(localId),
    toType: edit?.toType,
  })).filter((edit) => Number.isFinite(edit.localId) && edit.toType);
}

export function editsArrayToMap(edits, ifcIndex) {
  const map = new Map();
  for (const edit of edits || []) {
    const localId = Number(edit.localId);
    const toType = String(edit.toType || "").toUpperCase();
    if (!Number.isFinite(localId) || !toType) continue;
    const fromType = edit.fromType || ifcIndex?.entities?.get(localId)?.type || null;
    if (!fromType || fromType === toType) continue;
    map.set(localId, { fromType, toType });
  }
  return map;
}

export function safeFileName(fileName, fallback = "model") {
  const value = String(fileName || fallback)
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return value || fallback;
}

export async function blobToText(blob) {
  if (!blob) return "";
  if (typeof blob.text === "function") return blob.text();
  return new Response(blob).text();
}

export function textToIfcFile(text, fileName = "model.ifc") {
  return new File([text || ""], safeFileName(fileName, "model.ifc"), { type: "application/x-step" });
}

export function blobToGlbFile(blob, fileName = "model.glb") {
  return new File([blob], safeFileName(fileName, "model.glb"), { type: blob?.type || "model/gltf-binary" });
}
