---
allowed-tools: Read, Edit, Write, Bash(npm:*), Bash(jj:*), Bash(ls:*), Glob, Grep, Agent, TaskCreate, TaskUpdate, EnterPlanMode, ExitPlanMode, AskUserQuestion
description: Pick the next TODO item (or a specific one), plan it, implement it, test it, bump version, and push a CL
argument-hint: [todo-number]
---

# Implement Next TODO Item

You are going to implement a TODO item from this project end-to-end.

## Step 0: Read context

Read ALL markdown files in the project root to understand the project:
- @CLAUDE.md
- @DESIGN.md
- @TODO.md
- @README.md (if it exists)

## Step 1: Pick the TODO item

Argument passed: $ARGUMENTS

- If an argument (todo number) was provided, find that specific numbered item in TODO.md.
- If no argument was provided, find the **first non-completed** item in TODO.md. Completed items are struck through (~~strikethrough~~) or marked done.
- Show the user which item you picked and confirm before proceeding.

Ask if you shoud proceed via AskUserQuestion.

## Step 2: Plan

Enter plan mode. Create a detailed implementation plan for the chosen TODO item:
- Which files need to change
- What new files (if any) are needed
- IPC changes (remember the 4-file pattern from CLAUDE.md)
- Any dependencies or risks

Present the plan to the user. Wait for their comments or approval. Incorporate any feedback before moving on. Exit plan mode once the user approves.

## Step 3: Implement

Implement the plan. Follow all project conventions from CLAUDE.md:
- Vue components use `<script setup lang="ts">` with Composition API
- IPC pattern across 4 files if needed
- Keep DESIGN.md up to date if architecture changes
- No unnecessary comments or type annotations on unchanged code

## Step 4: Test

Run the app to verify:
```
npm run dev
```

Run type checking:
```
npm run typecheck
```

Tell the user the app is running and ask them to verify the feature works. Wait for the user to confirm testing is complete before proceeding.

## Step 5: Version bump

Ask the user how to bump the version in package.json:
1. **Patch** (last number, e.g. 1.1.2 → 1.1.3) — for small fixes/tweaks
2. **Minor** (middle number, e.g. 1.1.2 → 1.2.0) — for new features
3. **Major** (first number, e.g. 1.1.2 → 2.0.0) — for breaking changes
4. **No bump** — skip version change

Apply the chosen bump to package.json if applicable. Show the correct option in the option varians by your understanding.

## Step 6: Finalize and push

1. Strike through the completed item in TODO.md (wrap it with `~~`)
2. Update DESIGN.md if any architectural changes were made
3. Create a CL and push using jj (NEVER use git directly):

```bash
jj describe -m "Commit message describing the change"
jj bookmark set main -r @
jj git push
```

Craft a clear, concise commit message that describes what was implemented and why.
