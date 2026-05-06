// Injected by scripts/apply-plan-detector-output-fix.ps1
// Fixes the existing "Plan → IFC" panel so it downloads BOTH GLB and IFC,
// saves both in the local project store, and provides a direct Modeler link.
import { makeProjectId, saveProject, safeFileName, blobToText } from "/src/project-store.js";

const SMELT_PLAN_FIX_VERSION = "v7-plan-glb-ifc-output";

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statValue(stats, key) {
  return Number(stats?.[key] || 0);
}

function renderStat(value, label) {
  return `
    <div class="stat">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function keepObjectUrl(url) {
  window.__smeltPlanDetectorObjectUrls ||= [];
  window.__smeltPlanDetectorObjectUrls.push(url);
  return url;
}

function objectUrl(blob) {
  return keepObjectUrl(URL.createObjectURL(blob));
}

function downloadBlob(blob, filename) {
  const url = objectUrl(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return url;
}

function showPlanStatus(html, type = "processing") {
  const planStatus = document.getElementById("plan-status");
  if (!planStatus) return;
  planStatus.className = `status visible ${type}`;
  planStatus.innerHTML = html;
}

function getPlanFile(input) {
  return window.__smeltPlanDetectorSelectedFile || input?.files?.[0] || null;
}

function setPlanFile(file, button) {
  if (!file) return;
  window.__smeltPlanDetectorSelectedFile = file;
  if (button) {
    button.disabled = false;
    button.style.opacity = "1";
    button.textContent = `Détecter les murs de ${file.name} → GLB + IFC`;
  }
}

async function responseError(response, fallback) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const err = await response.json().catch(() => null);
    if (err?.error || err?.detail) return `${err.error || fallback}${err.detail ? " — " + err.detail : ""}`;
  }
  const text = await response.text().catch(() => "");
  return text || fallback;
}

function patchPlanButton() {
  const oldButton = document.getElementById("plan-go");
  const planDropzone = document.getElementById("plan-dropzone");
  const planFileInput = document.getElementById("plan-file-input");
  const scaleInput = document.getElementById("plan-scale");
  const heightInput = document.getElementById("plan-height");

  if (!oldButton || !planDropzone || !planFileInput || !scaleInput || !heightInput) return false;
  if (oldButton.dataset.smeltPlanFixVersion === SMELT_PLAN_FIX_VERSION) return true;

  // Clone the button to remove the old Plan→IFC-only listener from public/index.html.
  const button = oldButton.cloneNode(true);
  button.dataset.smeltPlanFixVersion = SMELT_PLAN_FIX_VERSION;
  oldButton.replaceWith(button);

  const currentFile = getPlanFile(planFileInput);
  if (currentFile) setPlanFile(currentFile, button);

  planFileInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) setPlanFile(file, button);
  });

  planDropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) setPlanFile(file, button);
  });

  button.addEventListener("click", async () => {
    const planFile = getPlanFile(planFileInput);
    if (!planFile) {
      showPlanStatus("Sélectionne d'abord un plan image.", "error");
      return;
    }

    const scale = Number(scaleInput.value);
    const height = Number(heightInput.value || 2.5);

    if (!Number.isFinite(scale) || scale <= 0) {
      showPlanStatus("Échelle invalide : renseigne une valeur mm/pixel positive.", "error");
      return;
    }

    if (!Number.isFinite(height) || height <= 0) {
      showPlanStatus("Hauteur invalide : renseigne une hauteur de mur positive en mètres.", "error");
      return;
    }

    button.disabled = true;
    const previousText = button.textContent;

    try {
      showPlanStatus('<span class="spinner"></span>Détection du plan → génération GLB…', "processing");

      const baseName = safeFileName(planFile.name.replace(/\.[^.]+$/i, ""), "plan");
      const glbName = safeFileName(`${baseName}.detected.glb`, "plan.detected.glb");
      const ifcName = safeFileName(`${baseName}.ifc`, "plan.ifc");

      const fd = new FormData();
      fd.append("image", planFile);
      fd.append("scale_mm_per_px", String(scale));
      fd.append("wall_height_m", String(height));

      const glbResponse = await fetch("/plan2glb", { method: "POST", body: fd });
      if (!glbResponse.ok) {
        throw new Error(await responseError(glbResponse, "Erreur pendant la génération GLB"));
      }

      const wallCount = glbResponse.headers.get("X-Wall-Count") || "?";
      const glbBlob = await glbResponse.blob();
      const glbFile = new File([glbBlob], glbName, { type: "model/gltf-binary" });
      const glbDownloadUrl = downloadBlob(glbBlob, glbName);

      showPlanStatus(`<span class="spinner"></span>${wallCount} mur(s) détecté(s) — GLB téléchargé, conversion IFC…`, "processing");

      const fdIfc = new FormData();
      fdIfc.append("glb", glbFile);

      const ifcResponse = await fetch("/api/convert", { method: "POST", body: fdIfc });
      if (!ifcResponse.ok) {
        throw new Error(await responseError(ifcResponse, "Erreur pendant la conversion IFC"));
      }

      const stats = JSON.parse(ifcResponse.headers.get("X-Conversion-Stats") || "{}");
      const ifcBlob = await ifcResponse.blob();
      const ifcText = await blobToText(ifcBlob);
      const ifcDownloadUrl = downloadBlob(ifcBlob, ifcName);

      const project = await saveProject({
        id: makeProjectId(),
        glbBlob: glbFile,
        glbFileName: glbName,
        ifcText,
        ifcFileName: ifcName,
        edits: [],
        source: "plan-detector-v7",
        planDetector: {
          version: SMELT_PLAN_FIX_VERSION,
          sourceImageName: planFile.name,
          scaleMmPerPx: scale,
          wallHeightM: height,
          wallCount,
          glbSize: glbBlob.size,
          ifcSize: ifcBlob.size,
        },
      });

      const modelerUrl = `/modeler.html?project=${encodeURIComponent(project.id)}`;
      const viewerUrl = `/viewer.html?project=${encodeURIComponent(project.id)}`;

      showPlanStatus(`
        <div class="status-line">
          <span class="status-label">Statut</span>
          <span class="status-value" style="color:var(--success)">✓ Plan détecté : GLB + IFC générés</span>
        </div>
        <div class="status-line">
          <span class="status-label">Murs détectés</span>
          <span class="status-value">${escapeHtml(wallCount)}</span>
        </div>
        <div class="status-line">
          <span class="status-label">GLB</span>
          <span class="status-value"><a class="viewer-link" href="${glbDownloadUrl}" download="${escapeHtml(glbName)}">Télécharger ${escapeHtml(glbName)} (${formatBytes(glbBlob.size)})</a></span>
        </div>
        <div class="status-line">
          <span class="status-label">IFC</span>
          <span class="status-value"><a class="viewer-link" href="${ifcDownloadUrl}" download="${escapeHtml(ifcName)}">Télécharger ${escapeHtml(ifcName)} (${formatBytes(ifcBlob.size)})</a></span>
        </div>
        <div class="status-line">
          <span class="status-label">Édition</span>
          <span class="status-value"><a class="viewer-link" href="${modelerUrl}">Ouvrir le GLB dans le modeler →</a></span>
        </div>
        <div class="status-line">
          <span class="status-label">Viewer IFC</span>
          <span class="status-value"><a class="viewer-link" href="${viewerUrl}">Ouvrir l'IFC dans le viewer →</a></span>
        </div>
        <div class="summary">
          <div class="status-line"><span class="status-label">Source</span><span class="status-value">${escapeHtml(planFile.name)}</span></div>
          <div class="status-line"><span class="status-label">Échelle</span><span class="status-value">${escapeHtml(scale)} mm/px</span></div>
          <div class="status-line"><span class="status-label">Hauteur murs</span><span class="status-value">${escapeHtml(height)} m</span></div>
        </div>
        <div class="stats">
          ${renderStat(statValue(stats, "wall"), "walls IFC")}
          ${renderStat(statValue(stats, "door"), "doors")}
          ${renderStat(statValue(stats, "window"), "windows")}
          ${renderStat(statValue(stats, "storeys") || 1, "storeys")}
        </div>
      `, "success");
    } catch (error) {
      console.error("[plan-detector-v7]", error);
      showPlanStatus(`<strong>Erreur :</strong> ${escapeHtml(error.message || error)}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = previousText || "Détecter → GLB + IFC";
    }
  });

  console.info(`[Smelt] Plan detector output fix active (${SMELT_PLAN_FIX_VERSION})`);
  return true;
}

function init() {
  const ok = patchPlanButton();
  if (!ok) {
    console.warn("[Smelt] Plan detector output fix: éléments du panel Plan introuvables.");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
