---
allowed-tools: Read, Edit, Write, Glob, Grep, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode
description: Research a feature idea and add a detailed TODO entry
argument-hint: <feature description>
---

# Add TODO Item

You are going to research a feature idea and add a well-structured entry to TODO.md.

Feature description: $ARGUMENTS

## Step 1: Read project context

Read ALL markdown files in the project root:
- @CLAUDE.md
- @DESIGN.md
- @TODO.md

Understand the project architecture, existing features, IPC patterns, and the TODO format.

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

## Step 4: Write the TODO entry

After getting answers, write a detailed TODO entry following the existing format in TODO.md:

```markdown
## N. Feature title

**Priority:** High/Medium/Low | **Effort:** Small/Medium/Large

Brief description of the problem or motivation.

**Plan:**
1. Step-by-step implementation plan
2. Reference specific files and functions
3. Include IPC changes if needed (4-file pattern)
4. Note edge cases or gotchas discovered during research
```

Requirements for the plan:
- Reference actual file paths and function names from the code you read
- If IPC changes are needed, list all 4 files
- Each step should be concrete and actionable
- Number the new entry sequentially after the last existing entry in TODO.md

Append the new entry at the end of TODO.md (before any trailing whitespace), separated by `---`.

After that make a CL and push it using jj.

