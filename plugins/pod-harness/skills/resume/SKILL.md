---
name: resume
description: Continues a pod harness task after a cleared session, a compaction or a stop. Use when someone wants to continue, resume or pick up a task the pod harness started, or asks which pod harness tasks are open.
argument-hint: [task id]
model: sonnet
effort: medium
---

# Continue a task

The task id, if one was given: $ARGUMENTS

## Rules

- Run the script and act on its JSON. Never edit a task's files yourself.
- Never print or store a secret.
- If the developer gives a home folder for testing, start every command with `POD_HARNESS_HOME="<folder>"` in Bash. In PowerShell run `$env:POD_HARNESS_HOME = '<folder>'` once first.

## Steps

1. With no task id, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" status`. List the tasks that are not `done`, each with its stage and status. With one such task, propose it. With several, ask which one. With none, say so and stop.
2. Load the `pod-harness:task` skill with the Skill tool, with the argument `resume <id>`. Continue at its Loop step with that id. Do not run its Intake or Start step.

A task whose status is `blocked` cannot be started again in this version. Its Loop step shows why it stopped and where the work is.
