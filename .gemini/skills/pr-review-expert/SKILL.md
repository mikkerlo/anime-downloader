---
name: pr-review-expert
description: Expert PR reviewer for the anime-downloader project. Focuses on architectural alignment with DESIGN.md, progress tracking via GitHub Issues, and thorough technical validation with direct code comments.
---

# PR Review Expert

Follow this workflow to perform high-quality code reviews for this project.

## Review Principles

1.  **Architecture First**: Always read `DESIGN.md` before starting a review. Ensure the PR doesn't break established patterns (e.g., IPC handlers, Vue 3 Composition API, storage modes).
2.  **Track Progress**: Check GitHub Issues to see if the PR completes existing tasks. Ensure the PR description correctly references these issues (e.g., "Fixes #123").
3.  **Tiered Feedback**: 
    - **In Chat**: Share "General Feedback" and "Specific Observations" with the user to provide context for your review.
    - **On GitHub**: Keep the review body concise and strictly limited to the final verdict. NEVER include the "General Feedback" or "Specific Observations" sections in the GitHub review body; those are exclusively for the chat. Focus on line-level suggestions for code changes.
4.  **Direct Action**: Always prefer line-level code comments and suggestions over general comments in the review body. Prefix minor issues or suggestions with "nit:".
5.  **Reliable Submission**: Use a JSON file to craft and submit the review (via `gh api`) to avoid errors with long shell commands and shell escaping.
6.  **Verified Approval**: Use explicit approval phrases like "LGTM after testing on Windows" or "LGTM after manual testing" to indicate thorough verification ONLY if code changes that require testing were made. ONLY use these phrases when you are ready to formally approve the PR.
## Workflow

### 1. Preparation
- Read `DESIGN.md`.
- View PR metadata: `gh pr view <id>`.
- **Read Related Issues**: If the PR description or metadata mentions related GitHub issues (e.g., "Fixes #49"), read those issues (`gh issue view <id>`) to understand the original requirements and context.
- Read the full diff: `gh pr diff <id>`.

### 2. Analysis
- Check for common project pitfalls:
    - Missing timer cleanups in `onBeforeUnmount` (in `PlayerView.vue` or `AnimeDetailView.vue`).
    - Redundant `electron-store` writes from watchers.
    - Improper path handling (should use `path.join`, sanitized filenames).
    - Hardcoded paths or constants that should be configurable.

### 3. Review Submission
- **Share with the user in Chat**:
    - Group observations into "General Feedback" and "Specific Observations".
    - Avoid excessive praise; focus on technical value and implementation details.
- **Submit to GitHub**:
    - Create a JSON file (e.g., `review.json`) containing the review payload. Note that the `"event"` field depends on the review outcome (`"APPROVE"`, `"REQUEST_CHANGES"`, or `"COMMENT"`):
      ```json
      {
        "body": "Brief summary of the review or final verdict only. DO NOT include General Feedback or Specific Observations here.",
        "event": "APPROVE", 
        "comments": [
          {
            "path": "src/renderer/src/components/AnimeDetailView.vue",
            "line": 123,
            "body": "```suggestion\nnew code\n```"
          }
        ]
      }
      ```
    - Use `gh api repos/{owner}/{repo}/pulls/{pull_number}/reviews --method POST --input review.json` to post the review (replace `{owner}`, `{repo}`, and `{pull_number}` with actual values, or use `:owner/:repo` if `gh` can infer them).
    - Ensure suggestions use the `suggestion` block format in GitHub comments if possible (e.g., "```suggestion\nnew code\n```").

### 4. Approval
- If everything looks good (or only minor non-blocking fixes are needed), approve the PR.
- **Mandatory Suffix for Approval**: ONLY if you are submitting a formal approval for code changes that require testing, append "LGTM after [manual/platform] testing" to the final review message. If the changes do not require testing (e.g., docs), use a standard "LGTM". DO NOT use this suffix for standard comments or if blocking issues (like conflict markers) remain.