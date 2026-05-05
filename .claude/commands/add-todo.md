---
allowed-tools: Read, Edit, Write, Glob, Grep, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, Bash(gh:*)
description: Research a feature idea and create a detailed GitHub issue with the todo tag
argument-hint: <feature description>
---

# Add TODO Issue

You are going to research a feature idea and create a well-structured GitHub issue with a `todo` tag.

Feature description: $ARGUMENTS

## Step 1: Read project context

Read ALL markdown files in the project root:
- @CLAUDE.md
- @DESIGN.md
- @TODO.md

Understand the project architecture, existing features, and IPC patterns.

## Step 2: Understand the feature

Based on the feature description, identify which parts of the codebase are relevant. Read the relevant source files to understand:
- How similar features are currently implemented
- What code already exists that this feature would touch or extend
- What IPC handlers, components, or modules are involved

Do NOT read every file — focus on the ones directly related to the described feature.

## Step 3: Ask clarifying questions

Ask the user clarifying questions to nail down the scope and design. Use AskUserQuestion with suggested answer options where possible. Good questions to consider:
- Priority (High / Medium / Low)
- Effort estimate (Small / Medium / Large)
- UX approach if multiple options exist (e.g. "Should this be a button in Settings or a context menu?")
- Scope boundaries (e.g. "Should this also handle X edge case, or keep it simple?")
- Integration points that aren't obvious from the description

Ask only the questions that matter — skip anything that's obvious from the description or code. Batch related questions into a single AskUserQuestion call when possible.

## Step 4: Create the GitHub Issue

After getting answers, write a detailed issue body strictly following the standardized issue template (refer to the **Issue / Plan Template** in `@CLAUDE.md` or `@GEMINI.md`). Make sure to include all sections (Motivation, Approach & Architecture, UI/UX, Implementation Plan by architectural boundary, Files to Touch, Testing Strategy, Risks & Edge Cases, and Out of Scope).

Create the issue using the GitHub CLI:

```bash
gh issue create --title "<Feature title>" --body "<body>" --label "todo"
```
