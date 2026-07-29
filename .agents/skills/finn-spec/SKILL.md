---
name: finn-spec
description: Interview the user about a raw idea until confident, then file build-ready issues in the Linear project «Термех». Use for Finn-loop's Codex spec interview, queue-ready issue drafting, or feature planning. Interactive; never run unattended.
---

# Finn-loop spec interview

Turn a raw idea into one or more Linear issues so complete that a build agent
needs nothing beyond each issue.

## Fixed scope

- Linear team: `NVR`
- Linear project: `Термех`
- Project ID: `d263a655-c8bd-4533-8f66-6f2850842ff0`
- Repository: `nvrtsky/reestr-docs-termech`
- Repository label: `repo:reestr-docs-termech`
- Drafted-spec label: `ТЗ составлено`

Never file Finn-loop work outside this project or without the repository label.

## 1. Research before asking

Read the relevant code first. Find the files involved, existing patterns,
architecture constraints, and current tests. Never ask the user something the
codebase can answer.

## 2. Interview in rounds

Ask 1–4 questions per round. Offer concrete options and put the recommended
option first. Ask only genuine product decisions:

- who sees the behavior, what happens, and where it lives;
- explicit scope boundaries;
- empty, loading, permission, and failure states;
- data migrations and existing-record behavior;
- what a founder must be able to verify in a browser.

After every round, apply this confidence test:

> Could two different engineers read this spec and ship the same observable
> behavior?

If not, ask another round. Never guess a product decision.

## 3. Split work safely

One issue must fit into one day of agent work or less. Split larger features
into an ordered chain. Each downstream issue must use Linear `blockedBy`
relations so the builder cannot start it before its prerequisite is Done.

## 4. Draft every issue

Use exactly this structure:

```md
## Problem

What user or business problem does this solve?

## Acceptance Criteria

- [ ] AC-1 — Observable, testable outcome
- [ ] AC-2 — Observable, testable outcome

## Non-goals

- NG-1 — Behavior that must not change
- NG-2 — Work explicitly deferred

## Relevant files

- path/to/file.ts — why it matters

## Test expectations

- Automated checks and focused tests required
- Browser or integration evidence required

## How to verify

1. Numbered manual step covering an AC
2. Exact expected result
```

Rules:

- Give every acceptance criterion a stable `AC-N` ID and every non-goal a
  stable `NG-N` ID.
- Acceptance criteria must be observable outcomes, not implementation tasks.
- No AC may require an NG. Resolve contradictions before filing.
- Cover every AC in `How to verify`.
- For rendered UI, include viewport, user role, empty/loading/error behavior,
  and screenshot expectations where relevant.

## 5. Confirm and file

Show the complete draft or ordered issue chain in chat and get the user's
explicit approval. Then create each issue:

- on team `NVR`;
- in project `Термех`;
- with labels `repo:reestr-docs-termech` and `ТЗ составлено`;
- with blocker relations from the approved chain.

Report every returned issue identifier and URL.

## Approval boundary

Never apply `agent-ready`. Only the human applies it after reading the filed
contract. That label is the approval gate between planning and autonomous work.
