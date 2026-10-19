# Термех repository guidance

## Scope

- Track repository work in GitHub issues and pull requests.
- GitHub repository: `nvrtsky/reestr-docs-termech`.
- Implement only stable `AC-N` criteria and preserve every `NG-N`.

## Verification

- Run `npm run typecheck`.
- Run `npm run build`.
- UI changes need browser or preview evidence for every founder-verification
  step. Missing evidence must be disclosed and escalated.
- Keep behavior-changing documentation synchronized with the code.

## Safety

- Start build work from a clean worktree.
- Do not mix issues in one PR.
- Do not broaden scope in PR comments or review findings.
- Use isolated worktrees for concurrent or scheduled build runs.
- Agents never merge or enable auto-merge.
