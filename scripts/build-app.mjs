import { cp, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(root, 'src', 'app');
const assetRoot = path.join(sourceRoot, 'assets');
const outputRoots = [path.join(root,'app'), path.join(root,'frontend','public','legacy')];
const assetNames = await readdir(assetRoot);
const { registryFeedbackOverlay } = await import('./registry-feedback-overlay.mjs');
const { registryPreviewOverlay } = await import('./registry-preview-overlay.mjs');
const { registryUsabilityOverlay } = await import('./registry-usability-overlay.mjs');
const { registryDrawerOverlay } = await import('./registry-drawer-overlay.mjs');
const { registryAdminRoleOverlay } = await import('./registry-admin-role-overlay.mjs');
const { registryUploadModalOverlay } = await import('./registry-upload-modal-overlay.mjs');
const { registryYellowOverlay } = await import('./registry-yellow-overlay.mjs');
let html = registryYellowOverlay(registryUploadModalOverlay(registryAdminRoleOverlay(registryDrawerOverlay(registryUsabilityOverlay(registryPreviewOverlay(registryFeedbackOverlay(await readFile(path.join(sourceRoot, 'production', 'legacy-baseline-20261019.html'), 'utf8'))))))));

const { registrySectionOverlay } = await import('./registry-section-overlay.mjs');
html = registrySectionOverlay(html);

// Keep the deployed baseline immutable; rename only the entry button and its help text.
html = html.replaceAll('＋ Создать документ', '+ Добавить документ')
  .replaceAll('Нажмите «Создать документ»', 'Нажмите «+ Добавить документ»')
  .replaceAll('Кнопка «Создать документ» открывает', 'Кнопка «+ Добавить документ» открывает');

for (const outputRoot of outputRoots) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, 'index.html'), html, 'utf8');

  await Promise.all(
    assetNames.map((name) =>
      copyFile(path.join(assetRoot, name), path.join(outputRoot, /^[a-f0-9-]{36}$/.test(name) && name !== '8806a829-aaac-4231-912d-276bb4fddfa4' ? `${name}.woff2` : name)),
    ),
  );
}

for (const outputRoot of outputRoots) await copyFile(path.join(sourceRoot, 'production', 'runtime-20261019.js'), path.join(outputRoot, '8806a829-aaac-4231-912d-276bb4fddfa4.js'));

console.log(`Working app assembled in ${outputRoots.join(' and ')}`);

for (const outputRoot of outputRoots) for (const name of ['attachment-preview.js','attachment-preview.css']) await copyFile(path.join(sourceRoot,name),path.join(outputRoot,name));

for (const outputRoot of outputRoots) { await cp(path.join(sourceRoot,'vendor'),path.join(outputRoot,'vendor'),{recursive:true}); for (const name of ['attachment-pdf.js','attachment-picker.js']) await copyFile(path.join(sourceRoot,name),path.join(outputRoot,name)); }
