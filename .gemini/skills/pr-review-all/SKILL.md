---
name: pr-review-all
description: Finds all open PRs in the repository and reviews them sequentially using the pr-review-expert workflow, utilizing subagents where necessary.
---

# PR Review All

This skill automates the process of finding and reviewing all open Pull Requests in the repository.

## Workflow

1. **Find Open PRs**:
   - Run `gh pr list --state open --json number,title` to retrieve a list of all currently open pull requests.
2. **Sequential Review**:
   - Iterate through each open PR one by one.
   - For each PR, follow the `pr-review-expert` workflow. 
   - You MUST utilize a subagent (e.g., using `invoke_agent` with the `generalist` or `codebase_investigator` agent, instructing it to use `gemini-3.1-pro-preview` model if applicable) to brainstorm, analyze, and draft the actionable review payload.
   - Alternatively, you can use the `pr-review-expert` skill yourself if you are handling it directly.
3. **Draft and Post**:
   - Save the generated review payload to a temporary JSON file (e.g., `/tmp/review_<pr_number>.json`).
   - Post the review using the GitHub API (`gh api repos/:owner/:repo/pulls/<pr_number>/reviews --method POST --input /tmp/review_<pr_number>.json`).
   - Delete the temporary JSON file once the review is successfully posted (`rm /tmp/review_<pr_number>.json`).
4. **Iterate**:
   - Move on to the next PR in the list. Do not stop until all open PRs have been reviewed.

## Rules
- **Do not skip PRs**: Ensure every PR found in the list receives a review.
- **Cleanup**: Always clean up the temporary `/tmp` files.
- **Independence**: Treat each PR review as an independent task, ensuring contexts do not leak between reviews.