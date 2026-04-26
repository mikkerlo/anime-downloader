---
name: next
description: Pick the next TODO item (or issue/PR), plan it, implement it, test it, bump version, and push a CL
---

# Implement Next TODO Item, Issue, or PR

Implement a TODO item, GitHub issue, or Pull Request end-to-end, following the project's established patterns and versioning workflow.

## Workflow

1.  **Context Review**: Read `GEMINI.md`, `DESIGN.md`, `TODO.md`, and `README.md`.
2.  **Item Selection**: 
    *   If an argument was provided (TODO number, issue number, or PR number), find that specific item. For issues and PRs, use `gh issue view <number>` or `gh pr view <number>` to fetch details. If the issue or PR does not have the "Ready for implementation" label, you MUST warn the user and ask for confirmation.
    *   Otherwise, find the first non-completed item in `TODO.md`.
    *   Confirm the selection with the user via `ask_user`.
3.  **Planning**: Use `enter_plan_mode` (or standard planning) to create a detailed implementation plan (files to change, IPC updates, risks). Get user approval before exiting plan mode.
4.  **Implementation**: Follow all conventions in `GEMINI.md` (Composition API, 4-file IPC pattern, etc.).
5.  **Testing**:
    *   Run `npm run dev` and `npm run typecheck`.
    *   Ask the user to verify the feature works.
6.  **Version Bump**: Ask the user (via `ask_user`) for the version bump type (Patch, Minor, Major, or None) and update `package.json`.
7.  **Finalization**:
    *   If it was a TODO item, strike through the item in `TODO.md` (`~~`).
    *   If it was an issue, ensure the commit message references it (e.g., "Fixes #<number>").
    *   Update `DESIGN.md` if necessary.
8.  **Commit and Push**: Use `jj` for the final commit.
    ```bash
    jj describe -m "Commit message. Fixes #<issue-number>"
    jj bookmark set main -r @
    jj git push
    ```
