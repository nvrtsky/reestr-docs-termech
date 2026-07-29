---
name: finn-build
description: Claim the next safe agent-ready issue from the Linear project «Термех», implement it, verify it, and open a PR. Use for Finn-loop's builder queue, a Codex scheduled run, or review-feedback repairs. One pass does one unit of work.
---

# Finn-loop builder

One pass fixes review feedback on one PR or builds one approved issue end to
end. Never merge.

## Fixed scope

- Linear team: `NVR`
- Linear project: `Термех`
- Project ID: `d263a655-c8bd-4533-8f66-6f2850842ff0`
- Repository: `nvrtsky/reestr-docs-termech`
- Required Linear repository label: `repo:reestr-docs-termech`

Never claim an issue from another project or repository.

## 0. Preflight

Before changing Linear, GitHub, branches, or files:

- Confirm `origin` is `nvrtsky/reestr-docs-termech` and is reachable.
- Detect the default branch with
  `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
- Require `git status --porcelain` to be empty. If dirty, report the paths and
  end the pass. Never stash, reset, overwrite, or commit unrelated work.
- Confirm the Linear MCP server can read project `Термех`.

## 1. Repair review feedback first

List open PRs labeled `loop-changes-requested`:

```bash
gh pr list --state open --label loop-changes-requested \
  --json number,title,headRefName,headRefOid,labels,updatedAt,url
```

Skip PRs carrying `needs-human-review` or `loop-stuck`. Confirm that `Closes
NVR-NNN` links to an issue in project `Термех` with
`repo:reestr-docs-termech`. Choose the least recently updated remaining PR.

Read its issue and latest `Finn-loop review of COMMIT_SHA`. Fix only
`Must fix before merge`, run relevant checks, push, remove
`loop-changes-requested`, and comment with the fix and evidence.

Allow at most two failed fix rounds. If a fresh reviewer requests a third
round, add `loop-stuck` and `needs-human-review`, remove
`loop-changes-requested`, and stop.

If a fix crosses an `NG-N` or needs a product decision, add
`needs-human-review`, remove `loop-changes-requested`, comment with the exact
contract conflict, and stop.

## 2. Pick

Using Linear, list issues meeting every condition:

- team `NVR`;
- project `Термех`;
- labels `agent-ready` and `repo:reestr-docs-termech`;
- unassigned;
- not labeled `blocked`;
- no unresolved `blockedBy` relation.

Sort by priority, then oldest first. If empty, say so and end. Never invent
work.

## 3. Claim

Assign yourself and move the issue to `In Progress` before reading deeply or
editing code. Immediately re-fetch it. If it is blocked, assigned to somebody
else, outside the fixed scope, or no longer `agent-ready`, do not work it and
return to picking.

Only one builder loop may run for this team/repository scope.

## 4. Read the contract

Fetch the full issue, comments, labels, project, and relations. Implement only
its ACs. NGs are binding. Compare every `AC-N` with every `NG-N`.

If an AC is ambiguous, conflicts with an NG, or depends on an unresolved
blocker, go to `Blocked`. Never guess.

## 5. Build

- Fetch the latest default branch.
- Create or resume `NVR-NNN-short-slug`.
- Follow the repository's architecture and naming.
- Add or update tests for logic, data flow, permissions, integrations, and
  visible behavior.
- Update the matching architecture/runbook documentation for behavior changes,
  or explain in the PR why no docs change is justified.
- Preserve behavior outside the issue contract.

## 6. Verify

Run the narrowest relevant tests plus the repository gates:

```bash
npm run typecheck
npm run build
```

For UI changes, execute every `How to verify` step against a real local or
deployment preview. Record `PASS` or `FAIL` per step and capture screenshots
when requested. If a required browser/preview environment is unavailable, do
not claim success: disclose it and apply `needs-human-review`.

Review `git diff` and `git status`. Stop on unrelated changes or generated
secrets.

## 7. Ship

Push and open one PR. Its body must include:

- what changed and why;
- `Closes NVR-NNN`;
- one evidence line per `AC-N`;
- one preservation line per `NG-N`;
- `Other behavior changes: None`;
- automated checks with exact results;
- numbered founder-verification steps;
- preview URL and screenshot evidence for rendered UI, when available;
- documentation changed, or a concrete no-docs justification;
- risk: Low / Medium / High.

If `Other behavior changes: None` is false, stop and amend the Linear contract
before opening the PR.

Comment the PR URL on the Linear issue. Leave it in `In Progress` unless a
review state exists. Never merge or enable auto-merge.

## 8. Blocked

Comment one specific question a human can answer asynchronously, apply
`blocked`, and unassign yourself. Keep `agent-ready`; the picker excludes
`blocked`.

State the decision, concrete options, the recommended option, and affected AC.
End the pass so a future iteration can pick other work.
