---
name: pr-review-all
description: Review open PRs in this repo sequentially using the pr-review workflow. By default only PRs with no approvals yet; pass "all" to review every open PR, or explicit PR numbers to review just those.
---

# PR Review All

Find open pull requests, select which need a review, and run the `pr-review` skill workflow (`.claude/skills/pr-review/SKILL.md`) on each. Read that file first — it carries the shell gotchas (zsh quoting), the line-anchoring rules, and the posting mechanics; don't rediscover them per PR.

## 1. Select PRs

Interpret the argument:

- **No argument (default)**: only PRs without any approval —
  ```bash
  gh pr list --state open --json number,title,reviews \
    --jq '.[] | select(([.reviews[] | select(.state=="APPROVED")] | length) == 0) | "\(.number)\t\(.title)"'
  ```
  (Filter on the `reviews` array, not `reviewDecision` — the latter reflects branch-protection requirements and is empty/misleading on repos without required reviews.)
- **`all`**: every open PR — `gh pr list --state open --json number,title`.
- **PR numbers**: review exactly those.

If the default filter selects nothing, say so and stop — don't silently escalate to reviewing approved PRs.

## 2. Review each, sequentially

For each selected PR, follow the `pr-review` skill workflow start to finish: gather (view + diff + checks + existing reviews in one parallel batch), read `DESIGN.md`/relevant `docs/` pages and linked issues, analyze against the project checklist, post the review via a scratchpad JSON payload, delete the payload.

Rules:

- **Independence**: each PR is a fresh review — don't let a conclusion about one PR leak into another beyond shared repo knowledge (docs read once are fine to reuse).
- **No skipping**: every selected PR gets a posted review, even if the verdict is a one-line approve.
- **Sequential**: one PR at a time; the batching happens *within* a PR's gather step, not across PRs.
- **Cleanup**: no payload JSON files left behind.

## 3. Final report

One chat message at the end covering all PRs: per PR, the verdict posted, the substantive findings (restated per the tiered-feedback rules in `pr-review` — General Feedback / Specific Observations), and anything cross-cutting (e.g. two PRs touching the same subsystem that should merge in a particular order).
