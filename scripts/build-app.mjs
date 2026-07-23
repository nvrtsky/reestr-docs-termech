import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

for (const outputRoot of outputRoots) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, 'index.html'), fragments.join(''), 'utf8');

  await Promise.all(
    assetNames.map((name) =>
      copyFile(path.join(assetRoot, name), path.join(outputRoot, name)),
    ),
  );
}

console.log(`Working app assembled in ${outputRoots.join(' and ')}`);
