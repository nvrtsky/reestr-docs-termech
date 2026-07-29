# Термех repository guidance

## Source of truth

- Product scope and approval live in Linear project `Термех` on team `NVR`.
- Every repository issue must carry `repo:reestr-docs-termech`.
- GitHub repository: `nvrtsky/reestr-docs-termech`.
- Implement only stable `AC-N` criteria and preserve every `NG-N`.

## Finn-loop

- Use `$finn-spec` interactively to research, interview, and draft issues.
- Only a human applies Linear label `agent-ready`.
- Use `$finn-build` for one approved issue or one bounded repair pass.
- Use `$finn-review` in fresh context for one independent PR review.
- Agents never merge or enable auto-merge.

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
