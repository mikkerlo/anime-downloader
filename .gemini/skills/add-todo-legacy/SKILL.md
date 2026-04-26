---
name: add-todo-legacy
description: Research a feature idea and add a detailed TODO entry
---

# Add TODO Item

You are going to research a feature idea and add a well-structured entry to `TODO.md`.

## Workflow

1.  **Read project context**: Read `GEMINI.md`, `DESIGN.md`, and `TODO.md` to understand the architecture, existing features, and the TODO format.
2.  **Research the feature**: Identify relevant parts of the codebase. Read the source files to understand implementation patterns and integration points. Focus on files directly related to the feature.
3.  **Clarify requirements**: Use `ask_user` to nail down the scope, priority, effort, and design. Batch related questions into a single call.
4.  **Draft the TODO entry**: Write a detailed entry following the sequential numbering in `TODO.md`. Include:
    *   **Priority** (High/Medium/Low)
    *   **Effort** (Small/Medium/Large)
    *   **Description** of the motivation.
    *   **Plan**: Step-by-step implementation, referencing specific files/functions and IPC changes (4-file pattern).
5.  **Finalize**: Append the entry to `TODO.md` (separated by `---`).
6.  **Commit and Push**: Use `jj` to describe and push the change.
    ```bash
    jj describe -m "Add TODO: <feature title>"
    jj bookmark set main -r @
    jj git push
    ```
