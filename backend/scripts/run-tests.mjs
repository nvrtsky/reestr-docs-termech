import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const testFiles = collectTestFiles(path.resolve('src'));

if (!testFiles.length) {
  throw new Error('No backend test files were found.');
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
  { stdio: 'inherit', env: process.env },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTestFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [entryPath] : [];
    });
}
