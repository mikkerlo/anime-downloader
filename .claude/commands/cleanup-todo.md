---
allowed-tools: Read, Edit, Bash(jj:*)
description: Clean up TODO.md — move completed items to Done, remove strikethrough sections, renumber
---

Read TODO.md and clean it up:

1. Find any detailed plan sections that are fully struck through (wrapped in `~~`) — these are completed items whose plans are still lingering in the file
2. If those completed items aren't already listed in the "## Done" checklist at the top, add them as `- [x]` entries with a short summary
3. Remove the full strikethrough detail sections (header, priority/effort line, description, plan steps) and their surrounding `---` separators
4. Renumber the remaining (non-completed) sections sequentially starting from 1
5. Describe and push the change using jj:
   - `jj describe -m "Clean up TODO.md: remove completed strikethrough sections, renumber remaining items"`
   - `jj bookmark set main -r @`
   - `jj git push`
