// Injected by scripts/apply-plan-detector-output-fix.ps1
// Prevents the IFC viewer from staying forever on "Initialisation du viewer…".
(function () {
  const VERSION = "v7-viewer-init-guard";
  function init() {
    const status = document.getElementById("status");
    if (!status || status.dataset.smeltViewerInitGuard === VERSION) return;
    status.dataset.smeltViewerInitGuard = VERSION;

    window.setTimeout(() => {
      const text = String(status.textContent || "").toLowerCase();
      if (!text.includes("initialisation")) return;

      const params = new URLSearchParams(window.location.search);
      const project = params.get("project") || "";
      const modelerUrl = project
        ? `/modeler.html?project=${encodeURIComponent(project)}`
        : "/modeler.html";

      status.className = "status error";
      status.innerHTML = `Le viewer IFC n'a pas fini son initialisation. Le projet local est probablement créé, mais le chargement IFC est bloqué côté viewer.<br><br><a class="link-button" href="${modelerUrl}">Ouvrir le GLB dans le modeler →</a> <a class="link-button" href="/">Retour</a>`;
    }, 12000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
