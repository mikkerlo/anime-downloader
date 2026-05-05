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
4.  **Draft the TODO entry**: Write a detailed entry following the sequential numbering in `TODO.md` and strictly following the project's standardized issue template (refer to the **Issue / Plan Template** in `GEMINI.md`). Make sure to include all sections (Motivation, Approach & Architecture, UI/UX, Implementation Plan by architectural boundary, Files to Touch, Testing Strategy, Risks & Edge Cases, and Out of Scope).
5.  **Finalize**: Append the entry to `TODO.md` (separated by `---`).
6.  **Commit and Push**: Use `jj` to describe and push the change.
    ```bash
    jj describe -m "Add TODO: <feature title>"
    jj bookmark set main -r @
    jj git push
    ```
