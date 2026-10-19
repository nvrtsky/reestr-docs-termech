import assert from 'node:assert/strict';
export function registryDrawerOverlay(source) {
  const original = '<div style="position: fixed; inset: 0; z-index: 40;">';
  assert.equal(source.split(original).length, 2, 'One document drawer expected');
  let html = source.replace(original, '<div data-registry-drawer style="position: fixed; inset: 0; z-index: 40;">');
  const backdrop = '<div onclick="{{ closeDoc }}" style="position: absolute; inset: 0; background: rgba(24,24,27,.32);';
  assert.equal(html.split(backdrop).length, 2);
  html = html.replace(backdrop, backdrop.replace('<div ', '<div data-registry-drawer-backdrop '));
  const panel = '<div style="position: absolute; top: 0; right: 0; height: 100%; width: 470px;';
  assert.equal(html.split(panel).length, 2);
  html = html.replace(panel, panel.replace('<div ', '<div data-registry-drawer-panel '));
  return html.replace('</head>', `<style>
/* The content wrapper must not anchor the drawer below the app header. */
.registry-shell[data-embedded="true"] > .registry-content:has([data-registry-drawer]) { position:static !important; }
/* The backdrop covers the full app; only the panel follows the visible iframe region. */
.registry-shell.registry-shell[data-embedded="true"] [data-registry-drawer][style] { top:0 !important; height:100% !important; }
.registry-shell[data-embedded="true"] [data-registry-drawer-panel] { top:var(--registry-dialog-top,0px) !important; height:var(--registry-dialog-height,100vh) !important; }
</style></head>`);
}
