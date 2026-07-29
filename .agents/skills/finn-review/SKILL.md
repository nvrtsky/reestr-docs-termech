---
name: finn-review
description: Review open PRs for the «Термех» Linear project against their exact issue contract, required GitHub checks, and verification evidence. Use for Finn-loop's review queue or a Codex scheduled review run. Never merges or pushes code.
---

# Finn-loop reviewer

One pass reviews one PR. Use fresh context independent from the builder.

## Fixed scope

- Linear team: `NVR`
- Linear project: `Термех`
- Repository: `nvrtsky/reestr-docs-termech`
- Required Linear repository label: `repo:reestr-docs-termech`

## 1. Find a PR needing review

```bash
gh pr list --state open \
  --json number,title,labels,isDraft,headRefOid,updatedAt,url
```

Skip drafts and PRs labeled `loop-stuck`. For each PR, find the latest comment
whose first line is `Finn-loop review of COMMIT_SHA`.

Skip a PR when the recorded SHA equals its current `headRefOid` and it already
has `loop-approved`, `loop-changes-requested`, or `needs-human-review`. Review
again after a new commit.

## 2. Validate scope and contract

- Parse `Closes NVR-NNN` from the PR body.
- Fetch the full Linear issue, comments, relations, project, and labels.
- Missing issue, wrong project, or missing `repo:reestr-docs-termech` is a
  must-fix scope finding.
- Read the full diff and every changed file in context.
- Review against ACs, NGs, defects, security, loading/error states, tests,
  verification evidence, and maintainability.

Every must-fix starts with:

- `[AC-N]` — an acceptance criterion is not met;
- `[DEFECT]` — broken in-scope behavior;
- `[SECURITY]` — a severe security issue;
- `[CI]` — a required check failed;
- `[SCOPE]` — wrong issue/project/repository or unrelated changes.

If a fix would violate an NG, report `[SCOPE-CONFLICT AC-N ↔ NG-N]` and
escalate to a human instead of prescribing code.

## 3. Independently verify

Inspect the exact head commit:

```bash
gh pr view NUMBER --json headRefOid,mergeable,mergeStateStatus
gh pr checks NUMBER --required --json bucket,name,state,link
```

- Pending checks or unknown mergeability: report waiting and end without a
  verdict or label mutation.
- Failed required checks: `[CI]`.
- Merge conflict: `[DEFECT]`.
- No required checks: escalate with `needs-human-review`; never
  `loop-approved`.

For rendered UI:

- require a preview URL or reproducible local start command;
- execute the issue's `How to verify` steps in a browser when the environment
  provides browser access;
- compare fresh results with builder evidence;
- treat a missing preview, missing required screenshots, or failed step as
  must-fix or human escalation as appropriate.

For behavior changes, require architecture/runbook documentation or a concrete
PR justification for no docs change.

Re-fetch `headRefOid` immediately before posting. If it changed, discard the
review and retry on a later pass.

## 4. Post one verdict

```md
Finn-loop review of COMMIT_SHA

CI: required checks passed | failed | not configured
Mergeability: clean | conflicting
Verification: passed | failed | human verification required

## Review

Summary: one or two plain-language sentences.

## 1. Must fix before merge

None.

## 2. Should fix soon

None.

## 3. Safe to merge

Yes — automated review evidence is complete. A human still makes the merge decision.
```

Set labels:

- no must-fix, no escalation, required CI green, verification complete:
  add `loop-approved`; remove `loop-changes-requested`;
- must-fix: add `loop-changes-requested`; remove `loop-approved`;
- scope conflict, no required CI, or required human verification: add
  `needs-human-review`; remove `loop-approved` and
  `loop-changes-requested`; set safe-to-merge to No.

Preserve a pre-existing `needs-human-review` until a human resolves it.

## Hard limits

- Never merge, enable auto-merge, or push commits.
- Never use formal GitHub approve/request-changes reviews. Use one comment and
  labels because the loop may run as the PR author.
- `loop-approved` is evidence for the human merge decision, not permission.
