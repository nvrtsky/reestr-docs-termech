import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const sourceRoot = path.join(root, 'src', 'app');
const fragmentRoot = path.join(sourceRoot, 'fragments');
const assetRoot = path.join(sourceRoot, 'assets');
const outputRoots = [
  path.join(root, 'app'),
  path.join(root, 'frontend', 'public', 'legacy'),
];

const legacyAssetOutputNames = new Map([
  ['8806a829-aaac-4231-912d-276bb4fddfa4', '8806a829-aaac-4231-912d-276bb4fddfa4.js'],
  ['490b628c-b43b-47a5-9bc5-0e57b9a14a91', '490b628c-b43b-47a5-9bc5-0e57b9a14a91.woff2'],
  ['6a110c9e-a04f-4f9b-a918-95d37b75d5a9', '6a110c9e-a04f-4f9b-a918-95d37b75d5a9.woff2'],
  ['abdb1960-8210-47de-8656-f70ca00658ea', 'abdb1960-8210-47de-8656-f70ca00658ea.woff2'],
  ['31efea23-8e0e-4a43-bcd0-0ac1abcfc94f', '31efea23-8e0e-4a43-bcd0-0ac1abcfc94f.woff2'],
  ['2d7a279b-40c0-4f8e-9ff7-d8952e8cb693', '2d7a279b-40c0-4f8e-9ff7-d8952e8cb693.woff2'],
  ['b96a584d-70cf-40e2-b576-0e6304b8d6ca', 'b96a584d-70cf-40e2-b576-0e6304b8d6ca.woff2'],
]);

const fragmentNames = (await readdir(fragmentRoot))
  .filter((name) => name.endsWith('.html') || name.endsWith('.js'))
  .sort();

if (fragmentNames.length !== 6) {
  throw new Error(`Expected 6 app fragments, found ${fragmentNames.length}.`);
}

const fragments = await Promise.all(
  fragmentNames.map((name) => readFile(path.join(fragmentRoot, name), 'utf8')),
);
const assetNames = await readdir(assetRoot);
const missingLegacyAssets = [...legacyAssetOutputNames.keys()]
  .filter((name) => !assetNames.includes(name));

if (missingLegacyAssets.length) {
  throw new Error(`Missing mapped legacy assets: ${missingLegacyAssets.join(', ')}.`);
}

const legacyHtml = [...legacyAssetOutputNames.entries()].reduce(
  (html, [sourceName, outputName]) => html.replaceAll(sourceName, outputName),
  fragments.join(''),
);

for (const outputRoot of outputRoots) {
  await mkdir(outputRoot, { recursive: true });
  await Promise.all(
    [...legacyAssetOutputNames.keys()].map((name) =>
      rm(path.join(outputRoot, name), { force: true }),
    ),
  );
  await writeFile(path.join(outputRoot, 'index.html'), legacyHtml, 'utf8');

  await Promise.all(
    assetNames.map((name) =>
      copyFile(
        path.join(assetRoot, name),
        path.join(outputRoot, legacyAssetOutputNames.get(name) || name),
      ),
    ),
  );
}

console.log(`Working app assembled in ${outputRoots.join(' and ')}`);
