---
name: next
description: Pick the next TODO item, plan it, implement it, test it, bump version, and push a CL
---

# Implement Next TODO Item

Implement a TODO item end-to-end, following the project's established patterns and versioning workflow.

## Workflow

1.  **Context Review**: Read `GEMINI.md`, `DESIGN.md`, `TODO.md`, and `README.md`.
2.  **Item Selection**: 
    *   If an argument (todo number) was provided, find that specific item.
    *   Otherwise, find the first non-completed item.
    *   Confirm the selection with the user via `ask_user`.
3.  **Planning**: Use `enter_plan_mode` to create a detailed implementation plan (files to change, IPC updates, risks). Get user approval before exiting plan mode.
4.  **Implementation**: Follow all conventions in `GEMINI.md` (Composition API, 4-file IPC pattern, etc.).
5.  **Testing**:
    *   Run `npm run dev` and `npm run typecheck`.
    *   Ask the user to verify the feature works.
6.  **Version Bump**: Ask the user (via `ask_user`) for the version bump type (Patch, Minor, Major, or None) and update `package.json`.
7.  **Finalization**:
    *   Strike through the item in `TODO.md` (`~~`).
    *   Update `DESIGN.md` if necessary.
8.  **Commit and Push**: Use `jj` for the final commit.
    ```bash
    jj describe -m "Commit message"
    jj bookmark set main -r @
    jj git push
    ```
