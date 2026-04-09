---
name: cleanup-todo
description: Clean up TODO.md — move completed items to Done, remove strikethrough sections, renumber
---

# Cleanup TODO

Read `TODO.md` and clean it up by removing completed items and re-indexing.

## Workflow

1.  **Analyze TODO.md**: Identify sections that are fully struck through (wrapped in `~~`).
2.  **Update Done list**: Ensure these completed items are listed in the "## Done" checklist at the top as `- [x]` entries.
3.  **Remove completed sections**: Delete the full strikethrough detail sections and their surrounding `---` separators.
4.  **Renumber**: Re-index the remaining (non-completed) sections sequentially starting from 1.
5.  **Commit and Push**: Use `jj` to describe and push the change.
    ```bash
    jj describe -m "Clean up TODO.md: remove completed strikethrough sections, renumber remaining items"
    jj bookmark set main -r @
    jj git push
    ```
