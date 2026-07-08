---
name: pr-review
description: Expert review of a single GitHub PR in this repo — architecture check against DESIGN.md/docs, linked-issue verification, line-anchored suggestions posted via gh api. Argument: the PR number.
---

# PR Review

Review one pull request end to end and post the review to GitHub. The argument is the PR number; if none was given, run `gh pr list --state open` and ask the user which one.

All review work happens through `gh` against the PR branch — **never** check the branch out or touch the working copy.

## Shell gotchas (read first, saves a failed call each)

The shell is **zsh**. Unquoted `?`, `=`, `*`, `[` are glob/expansion candidates and abort the whole command with `no matches found` / `command not found`:

- Always single-quote API URLs with query strings: `gh api 'repos/{owner}/{repo}/contents/path?ref=branch'`
- Quote glob-ish flags: `grep --include='*.ts'`, never `--include=*.ts`
- Don't use `echo ===MARKER===` as a separator in compound commands — `=word` triggers path expansion. Use `echo '---MARKER---'`.
- `gh api` supports `{owner}/{repo}` placeholders — it infers them from the repo; no need to hardcode.

## Trust the PR head, not the local checkout

This repo is driven by jj; the local working copy is often on an old or detached commit and does **not** match the PR base or head. Never compute review-comment line numbers from local files. Get the head version of a file, numbered:

```bash
gh api 'repos/{owner}/{repo}/contents/<path>?ref=<headRefName>' -q .content | base64 -d | cat -n
```

Local files are still fine for *context that the PR doesn't touch* (types a changed call site must conform to, sibling implementations) — just verify the region you rely on isn't itself part of the diff.

## Workflow

### 1. Gather everything in one parallel batch

Run these together (independent calls in a single message):

```bash
gh pr view <N>                                    # metadata + description
gh pr diff <N>                                    # the full diff (pipe through head/tail if huge)
gh pr view <N> --json reviews,mergeable,mergeStateStatus,headRefName
gh pr checks <N>                                  # CI status
```

Plus: read `DESIGN.md` (it is only an index) and the `docs/<subsystem>.md` pages for the subsystems the diff touches.

Then, if the PR body references issues ("Fixes #123"), `gh issue view <id>` — verify the PR actually implements what the issue planned, including its Risks/Out-of-Scope sections (issues here follow a rich template; the "Risks & Edge Cases" section is a ready-made review checklist).

Existing reviews matter: if the user already approved and the diff hasn't changed since, the review is a re-confirmation — still post it, but there is no need to re-litigate settled points.

### 2. Analyze

Verify the description's claims against the diff — don't take the summary's word for what the code does. Project-specific checklist:

- **Tests**: every behavior change must add/update tests in the same PR (CLAUDE.md hard rule). A feature PR with no test exercising the new behavior is incomplete → that alone justifies REQUEST_CHANGES.
- **IPC changes**: new channels must follow the 4-file pattern (`src/shared/ipc/channels.ts` → `src/main/ipc/<domain>.ipc.ts` → `src/preload/index.ts` + `types.d.ts`), broadcasts must use the `EventSubscriber` unsubscribe contract (never `removeAllListeners`), and `docs/ipc.md` must be updated.
- **Docs**: changes to IPC, settings (electron-store keys), or architecture require the matching `docs/<subsystem>.md` update in the same PR.
- **Error-path relocation**: code moved from a synchronous call path into a timer / `setTimeout` / detached promise changes where exceptions surface — in Electron main, an uncaught timer throw is a process-level error, not a rejected IPC promise. Flag missing try/catch.
- **Untyped string lists that mirror a schema** (key allowlists, channel-name arrays): suggest `keyof`-constrained types so renames fail typecheck.
- Classic pitfalls: missing timer cleanup in `onBeforeUnmount`; redundant electron-store writes from watchers; raw path concat instead of `path.join` + sanitized filenames; hardcoded paths that should be settings; version bump present when the PR should release.

### 3. Draft line-anchored comments

Prefer line comments with ` ```suggestion ` blocks over prose in the body. Prefix minor issues with `nit:`.

Anchoring rules (this is where reviews bounce with 422s):

- `line` + `"side": "RIGHT"` = line number in the **head** version (from the `cat -n` dump above). The line must be within the diff's changed hunks.
- A single-line comment's suggestion block replaces exactly that one line. To replace a range, use `"start_line": <first>, "start_side": "RIGHT", "line": <last>, "side": "RIGHT"` — the suggestion replaces the whole inclusive range, so reproduce every line of it (indentation exact).

### 4. Post

Write the payload to a JSON file in the scratchpad directory (never inline — shell escaping of multi-line suggestion bodies will mangle it):

```json
{
  "body": "Concise final verdict only.",
  "event": "APPROVE",
  "comments": [
    {
      "path": "src/main/store/index.ts",
      "start_line": 89,
      "start_side": "RIGHT",
      "line": 92,
      "side": "RIGHT",
      "body": "Why this matters, one paragraph.\n\n```suggestion\n<replacement for lines 89-92>\n```"
    }
  ]
}
```

```bash
gh api 'repos/{owner}/{repo}/pulls/<N>/reviews' --method POST --input <payload.json>
rm <payload.json>
```

`event` is `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`:

- **APPROVE** — correct, tested, documented; only nits or non-blocking suggestions remain.
- **COMMENT** — substantive questions the author should answer, but nothing provably broken.
- **REQUEST_CHANGES** — a real defect, missing required tests/docs, or conflict markers.

### 5. Report in chat (tiered feedback)

- **GitHub body**: verdict only, one short paragraph. Never paste the General Feedback / Specific Observations sections there.
- **Chat**: "General Feedback" (overall assessment, what was verified and how) and "Specific Observations" (each posted line comment, restated with file:line). No praise padding.
- **Approval suffix**: append "LGTM after manual testing" (or "LGTM after testing on <platform>") **only** on an APPROVE of code changes that genuinely need a manual run, and name the scenario worth exercising. Docs/CI-only changes get a plain "LGTM". Never use LGTM phrasing on COMMENT / REQUEST_CHANGES.
