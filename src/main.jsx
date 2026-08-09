/**
 * Film Halation — Photoshop UXP plugin entry.
 * Phase 0: minimal panel scaffold + capability probe trigger.
 */
import { runProbe } from './capability/probe.jsx';

function createPanel() {
  const panel = document.createElement('sp-panel');
  const heading = document.createElement('sp-heading');
  heading.textContent = 'Film Halation';
  const body = document.createElement('sp-body');
  body.textContent = 'Plugin scaffold ready (Phase 0).';
  const button = /** @type {HTMLElement & { disabled: boolean }} */ (document.createElement('sp-button'));
  button.textContent = 'Run capability probe';
  const out = document.createElement('pre');
  out.style.whiteSpace = 'pre-wrap';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const report = await runProbe();
      out.textContent = JSON.stringify(report, null, 2);
    } catch (e) {
      out.textContent = `Probe failed: ${e}`;
    } finally {
      button.disabled = false;
    }
  });
  panel.append(heading, body, button, out);
  return panel;
}

document.body.append(createPanel());

// Phase 0 spike: auto-run the capability probe on plugin load so results can be
// collected without manual UI interaction. Removed when the real UI lands (Phase 4).
(async () => {
  try {
    await runProbe();
  } catch (e) {
    console.error('[film-halation] auto probe failed: ' + e);
  }
})();
