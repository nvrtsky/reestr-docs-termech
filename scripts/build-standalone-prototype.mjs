import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const sourcePath = path.join(root, 'standalone', 'prototype.html');
const outputPath = path.join(root, 'index.html');
const runtimeAssetName = '8806a829-aaac-4231-912d-276bb4fddfa4';
const runtimePath = path.join(root, 'src', 'app', 'assets', runtimeAssetName);

const [source, initialBundle, runtime] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(outputPath, 'utf8'),
  readFile(runtimePath),
]);

const startMarker = '<script type="__bundler/template">';
const endMarker = '</script>';
const manifestMarker = '<script type="__bundler/manifest">';
const manifestStart = initialBundle.indexOf(manifestMarker);

if (manifestStart < 0) {
  throw new Error(`Manifest marker not found in ${outputPath}.`);
}

const manifestContentStart = manifestStart + manifestMarker.length;
const manifestEnd = initialBundle.indexOf(endMarker, manifestContentStart);

if (manifestEnd < 0) {
  throw new Error(`Manifest end marker not found in ${outputPath}.`);
}

const manifest = JSON.parse(initialBundle.slice(manifestContentStart, manifestEnd));
const runtimeEntry = manifest[runtimeAssetName];

if (!runtimeEntry) {
  throw new Error(`Runtime asset ${runtimeAssetName} not found in bundle manifest.`);
}

runtimeEntry.data = gzipSync(runtime).toString('base64');
runtimeEntry.compressed = true;

const bundle = `${initialBundle.slice(0, manifestContentStart)}
${JSON.stringify(manifest)}
  ${initialBundle.slice(manifestEnd)}`;
const start = bundle.indexOf(startMarker);

if (start < 0) {
  throw new Error(`Template marker not found in ${outputPath}.`);
}

const contentStart = start + startMarker.length;
const end = bundle.indexOf(endMarker, contentStart);

if (end < 0) {
  throw new Error(`Template end marker not found in ${outputPath}.`);
}

const encoded = JSON.stringify(source)
  .replaceAll('</script>', '<\\u002Fscript>');
const nextBundle = `${bundle.slice(0, contentStart)}\n${encoded}\n  ${bundle.slice(end)}`;

await writeFile(outputPath, nextBundle, 'utf8');

console.log(`Standalone prototype assembled in ${outputPath}`);
