# Finn-loop for «Термех»

This repository uses a human-gated loop:

```text
idea → finn-spec → Linear approval → finn-build → PR → finn-review → human merge
```

## Durable scope

- GitHub: `nvrtsky/reestr-docs-termech`
- Linear team: `NVR`
- Linear project: `Термех`
- Linear project ID: `d263a655-c8bd-4533-8f66-6f2850842ff0`
- Required repository label: `repo:reestr-docs-termech`

Linear is the source of truth for scope and approval. GitHub is the source of
truth for code, exact reviewed SHA, CI, conflicts, and merge state. Agents do
not merge.

## One-time setup

1. Trust this repository in Codex so `.codex/config.toml` is loaded.
2. Run `codex mcp login linear` once if Linear OAuth is not already active.
3. Restart Codex after the first setup if the new skills are not visible.
4. Run `/skills` and confirm `finn-spec`, `finn-build`, and `finn-review`.
5. Confirm GitHub CLI authentication with `gh auth status`.

## Daily use

Create specs interactively:

```text
$finn-spec
```

Read each filed Linear issue. A human adds `agent-ready` only after approving
the exact AC/NG contract.

Run one builder pass manually:

```text
$finn-build
```

Run one review pass in a second, independent Codex chat:

```text
$finn-review
```

For unattended loops, create two Scheduled tasks in the Codex desktop app:

- every 5 minutes, run `$finn-build` in an isolated worktree;
- every 5 minutes, run `$finn-review` in a separate chat.

Test both skills manually first and watch the first scheduled runs. Codex CLI
and the IDE extension can run the skills, but Scheduled task management lives
in the desktop app or ChatGPT web.

Merge only when the PR is conflict-free, the exact head SHA has
`loop-approved`, and required CI is green. Resolve every
`needs-human-review` or `loop-stuck` escalation first.

## Queue labels

### Linear

- `ТЗ составлено` — the spec exists but is not approved.
- `agent-ready` — a human approved the exact issue contract.
- `blocked` — the builder needs one concrete human decision.
- `repo:reestr-docs-termech` — isolates this repository from other NVR queues.

### GitHub

- `loop-approved` — automated evidence is complete; a human still merges.
- `loop-changes-requested` — the builder may repair in-scope must-fix findings.
- `needs-human-review` — automation stopped at a human decision or missing gate.
- `loop-stuck` — the bounded repair budget was exhausted.

## Safety rules

- One issue per PR and one builder loop for this scope.
- Downstream issues use Linear blocker relations.
- The builder must start from a clean worktree.
- A PR cannot broaden its Linear contract.
- UI work needs preview/browser evidence; missing evidence escalates.
- No required GitHub checks means no automated `loop-approved`.
- Agents never merge or enable auto-merge.

## Optional Slack control surface

The Linear project is linked to `#p-termeh`, but Finn-loop does not treat Slack
as durable state. Codex for Slack may start a Codex cloud chat from `@Codex`;
merge-ready notifications may be added later only after re-reading current
Linear/GitHub state. Slack reactions must never merge an unverified or changed
PR head.
