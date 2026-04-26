---
name: add-todo
description: Research a feature idea and create a detailed GitHub issue with the todo tag
---

# Add TODO Issue

You are going to research a feature idea and create a well-structured GitHub issue with a `todo` tag.

## Workflow

1.  **Read project context**: Read `GEMINI.md`, `DESIGN.md`, and `TODO.md` to understand the architecture and existing features.
2.  **Research the feature**: Identify relevant parts of the codebase. Read the source files to understand implementation patterns and integration points. Focus on files directly related to the feature.
3.  **Clarify requirements**: Use `ask_user` to nail down the scope, priority, effort, and design. Batch related questions into a single call.
4.  **Draft the Issue**: Write a detailed entry following the format we commit to `TODO.md`. Include:
    *   **Priority** (High/Medium/Low)
    *   **Effort** (Small/Medium/Large)
    *   **Description** of the motivation.
    *   **Plan**: Step-by-step implementation, referencing specific files/functions and IPC changes (4-file pattern).
5.  **Create Issue**: Create the issue using the GitHub CLI:
    ```bash
    gh issue create --title "<Feature title>" --body "<body>" --label "todo"
    ```
