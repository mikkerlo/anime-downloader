---
allowed-tools: Read, Edit, Write, Bash(npm:*), Bash(jj:*), Bash(gh:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), Glob, Grep, AskUserQuestion
description: Inspect review comments on a PR and either fix each one or reply explaining why it's intentional
argument-hint: <pr-number>
---

# Address PR Review Comments

You are going to triage every reviewer suggestion on a PR and either implement the fix or post a reply explaining why the current code is correct.

## Step 0: Resolve the PR number

Argument passed: $ARGUMENTS

- If an argument (PR number) was provided, use it.
- If no argument was provided, ask the user which PR to address using AskUserQuestion. Offer the most recent open PRs from `gh pr list --json number,title,headRefName --limit 5` as options.

Make sure the PR's branch is checked out locally (the working copy should be on it). If `jj log -r 'main..@'` doesn't include commits matching the PR's commits, ask the user to switch first — do not attempt to fetch/checkout for them.

## Step 1: Fetch comments and thread IDs

Run all three in parallel:

```bash
gh pr view <N> --json number,title,state,reviews,comments
gh api repos/<owner>/<repo>/pulls/<N>/comments --jq '.[] | {id, path, line, body, user: .user.login, created_at}'
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            path
            line
            comments(first: 10) {
              nodes { databaseId body author { login } }
            }
          }
        }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F pr=<N>
```

The first surfaces top-level review summaries (state, body); the second is the line-anchored inline comments — those are the ones you need to triage; the third gives you thread IDs (`PRRT_…`) needed in Step 6 to mark threads resolved after you fix them.

Filter out:
- Comments authored by the current user (`viewerDidAuthor: true`, or `author.login` matches `gh api user --jq .login`) — those are your own past replies, not new feedback.
- Already-resolved threads: drop any `reviewThreads` node where `isResolved: true`.
- Pure bot noise (e.g. `dependabot` version bumps). **Do not** skip `github-advanced-security` / CodeQL — those are real findings and must be triaged like human comments.

If the PR has multiple review rounds, focus on the **most recent** round's comments. Earlier rounds were already addressed in prior commits.

Keep a mapping of `(path, line, comment-body-excerpt) → thread-id` from the GraphQL response — you'll need it in Step 6.

## Step 2: Triage each comment

For every remaining comment, read the file at `path:line` (use Read with `offset` near the line to get surrounding context). Then make a verdict:

- **Fix it** — the comment identifies a real bug, missing edge case, or clear improvement. Plan the change.
- **Reply explaining** — the comment is based on a false premise (e.g. mentions a field that doesn't exist on the type), or you have a deliberate reason for the current design (matching upstream API shape, scope boundary deferred to another item, etc.). Draft a concise rebuttal.

Group your verdicts and present them to the user via AskUserQuestion (one question per comment if there are 1–4; if there are more, summarize as a list and ask "Proceed with these verdicts?"). Do not start coding until the user confirms or amends the plan.

When in doubt, lean toward fixing. Reviewers prefer a small accommodation over a long defense.

## Step 3: Create the fix commit, then implement

**Order matters.** jj snapshots the working copy into whichever commit is `@` at the moment you run the next jj command. If you edit files first and run `jj new` afterwards, the edits land in the parent commit (the original PR commit) — which is exactly the squash we want to avoid. So:

```bash
jj new -m "WIP: PR #<N> review fixes"
```

**Then** edit the relevant file(s):
- Follow project conventions from CLAUDE.md (Vue Composition API, 4-file IPC pattern, no needless comments, etc.).
- Re-run `npm run typecheck` after the batch of edits.

If a fix requires schema or architecture changes, update DESIGN.md alongside.

If you realize you already edited before running `jj new`, recover with `jj op log` → `jj op restore <op_id>` back to the clean state, then redo in the correct order.

## Step 4: Describe and push

Per the project's PR-review-fix convention (see user memory): **add a NEW commit on top of the existing commits — never squash into the original feature commit.** This keeps the review history legible and makes it obvious to the reviewer what changed in response to their feedback.

```bash
jj describe -m "fix: address PR #<N> review — <short list of what changed>"
jj bookmark set <branch-name> -r @
jj git push --bookmark <branch-name>
```

Commit message body should briefly explain each fix and why (one short paragraph per item is plenty). Avoid duplicating the reviewer's wording verbatim.

## Step 5: Reply on GitHub

Post a single consolidated comment on the PR summarizing what you did, using `gh pr comment <N> --body "$(cat <<'EOF' ... EOF)"`. Structure it as a numbered list mirroring the reviewer's points:

- For fixes: one or two sentences describing the change and the rationale.
- For "reply explaining" verdicts: explain the reasoning concretely — reference exact file paths, line numbers, type definitions, or upstream API shapes that justify the current design. Don't be defensive; assume the reviewer is acting in good faith and just lacked a piece of context.

## Step 6: Resolve the fixed threads

Using the `(path, line, body) → thread-id` mapping captured in Step 1, mark every thread you actually fixed (not the "Replied explaining" ones — leave those for the reviewer to resolve or push back on) as resolved via the GraphQL mutation:

```bash
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { id isResolved }
    }
  }' -F threadId=<PRRT_…>
```

Run one call per thread. If the mapping is ambiguous (multiple threads on the same path+line), match by a distinctive substring of the comment body instead.

End-of-turn report to the user: a one-line summary per comment (Fixed: ... / Replied: ...) plus the PR URL. Nothing else.

## Notes

- Never use `git commit` / `git push` directly — always `jj`.
- Never amend the original feature commit (`--amend`-style) — always a new commit.
- If a "fix" turns out to require larger scope work that wasn't requested, stop and ask the user before expanding scope. Note the limitation in the GitHub reply instead.
- If you can't determine the PR's repo from `gh pr view`, the working copy is probably not in a git/jj checkout — ask the user.
