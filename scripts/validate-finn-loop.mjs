import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const expectedSkills = ['finn-build', 'finn-review', 'finn-spec'];
const skillsRoot = path.join(root, '.agents', 'skills');
const actualSkills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

assert(
  JSON.stringify(actualSkills) === JSON.stringify(expectedSkills),
  `Expected ${expectedSkills.join(', ')}; found ${actualSkills.join(', ')}`,
);

for (const skillName of expectedSkills) {
  const relativePath = `.agents/skills/${skillName}/SKILL.md`;
  const text = read(relativePath);
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);

  assert(frontmatter, `${relativePath} is missing YAML frontmatter`);

  const fields = frontmatter[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const name = fields.find((line) => line.startsWith('name: '))?.slice(6);
  const description = fields
    .find((line) => line.startsWith('description: '))
    ?.slice(13);

  assert(
    fields.length === 2,
    `${relativePath} frontmatter must contain only name and description`,
  );
  assert(name === skillName, `${relativePath} name must be ${skillName}`);
  assert(description, `${relativePath} needs a description`);
  assert(!/\bTEAM\b/.test(text), `${relativePath} contains a TEAM placeholder`);
  assert(!/Claude Code|\/loop/.test(text), `${relativePath} contains Claude-only instructions`);

  const metadataPath = `.agents/skills/${skillName}/agents/openai.yaml`;
  assert(existsSync(path.join(root, metadataPath)), `${metadataPath} is missing`);
  const metadata = read(metadataPath);
  assert(metadata.includes('interface:'), `${metadataPath} needs interface metadata`);
  assert(
    metadata.includes('https://mcp.linear.app/mcp'),
    `${metadataPath} must declare the Linear dependency`,
  );
}

const spec = read('.agents/skills/finn-spec/SKILL.md');
const build = read('.agents/skills/finn-build/SKILL.md');
const review = read('.agents/skills/finn-review/SKILL.md');
const agents = read('AGENTS.md');
const codexConfig = read('.codex/config.toml');

const contracts = [
  [spec.includes('project `Термех`'), 'spec must target the Термех project'],
  [spec.includes('Never apply `agent-ready`'), 'spec must preserve human approval'],
  [build.includes('not labeled `blocked`'), 'builder must exclude blocked issues'],
  [build.includes('git status --porcelain'), 'builder must protect dirty worktrees'],
  [build.includes('defaultBranchRef'), 'builder must detect the default branch'],
  [build.includes('Never merge'), 'builder must never merge'],
  [review.includes('gh pr checks NUMBER --required'), 'review must inspect required checks'],
  [review.includes('Finn-loop review of COMMIT_SHA'), 'review must record the reviewed SHA'],
  [review.includes('Never merge'), 'reviewer must never merge'],
  [agents.includes('$finn-spec'), 'AGENTS.md must expose the spec skill'],
  [agents.includes('$finn-build'), 'AGENTS.md must expose the build skill'],
  [agents.includes('$finn-review'), 'AGENTS.md must expose the review skill'],
  [codexConfig.includes('[mcp_servers.linear]'), 'Codex must configure Linear MCP'],
  [codexConfig.includes('https://mcp.linear.app/mcp'), 'Linear MCP URL is missing'],
];

for (const [condition, message] of contracts) assert(condition, message);

console.log(
  `Validated ${expectedSkills.length} Codex skills and ${contracts.length} Finn-loop safety contracts.`,
);
