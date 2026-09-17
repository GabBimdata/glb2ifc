// A normal module import keeps Vite resolution and module caching intact.
// Report startup errors in the page instead of leaving a silent loading screen.
import('./modeler.js').catch(error => {
  console.error('Modeler startup failed:', error);
  const status = document.getElementById('status');
  if (status) {
    status.className = 'status error';
    status.textContent = `Impossible de démarrer le modeleur : ${error.message || error}. Recharge la page après avoir vérifié les fichiers installés.`;
  }
});
