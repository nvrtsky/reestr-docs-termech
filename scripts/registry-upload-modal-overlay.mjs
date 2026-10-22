import assert from 'node:assert/strict';

// The viewport probe reports coordinates relative to registry-shell. The
// positioned content wrapper must not offset the wizard by the app header.
export function registryUploadModalOverlay(source) {
  const start = source.indexOf('  <!-- ░░ CREATE WIZARD ░░ -->');
  const end = source.indexOf('  <!--', start + 40);
  assert(start >= 0 && end > start, 'Create wizard boundaries required');
  const wizard = source.slice(start, end);
  const overlay = '<div style="position: fixed; inset: 0; z-index: 50;';
  const panel = '<div class="registry-wizard"';
  assert.equal(wizard.split(overlay).length, 2);
  assert.equal(wizard.split(panel).length, 2);
  const html = source.slice(0, start) + wizard
    .replace(overlay, overlay.replace('<div ', '<div data-registry-upload-modal '))
    .replace(panel, '<div data-registry-upload-panel class="registry-wizard"')
    + source.slice(end);
  return html.replace('</head>', `<style>
html:has([data-registry-upload-modal]), body:has([data-registry-upload-modal]) { overflow-x:clip; }
.registry-shell[data-embedded="true"] > .registry-content:has([data-registry-upload-modal]) { position:static !important; }
[data-registry-upload-modal] { padding:16px; box-sizing:border-box; overscroll-behavior:contain; }
[data-registry-upload-modal] .registry-wizard { width:min(620px,100%) !important; max-width:100% !important; max-height:calc(100dvh - 32px) !important; }
.registry-shell.registry-shell[data-embedded="true"] [data-registry-upload-modal] > .registry-wizard { max-width:100% !important; max-height:calc(var(--registry-dialog-height,100dvh) - 32px) !important; }
[data-registry-upload-modal] .registry-wizard-scroll { min-height:0; overscroll-behavior:contain; }
</style></head>`);
}
