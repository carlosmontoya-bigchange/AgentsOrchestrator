---
name: task
description: Runs one development task through the pod's stages with the pod harness: intake, understanding, build, tests, review and close, with a checkpoint where the pod wants one. Use when someone asks the pod harness to do, build, fix or change something, or gives it a work item to work on.
argument-hint: <what to do, or a work item id>
model: sonnet
effort: medium
---

# Run a task

You take one request through the pod's stages. A script decides every step and you do what it says. Agents do the work and write reports. You talk to the developer.

The request: $ARGUMENTS

## Rules

- Do everything through `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" <command>`. Each command prints one JSON document. Act on what it prints.
- Never edit `state.json`, a work order, a brief or a stage report, and never write a brief. Only the scripts write those.
- You write three kinds of file, all in the task folder: the request, the tracker item, and a note with a change the developer asked for.
- Give an agent only the `prompt` from the action. Add nothing to it.
- Show `say` and every entry of `show` as they come: the stage, its lines and the path of its report. Do not rewrite them, and do not summarise what agents reply. The stage report does that.
- This version takes no outward action: no commit, push, pull request or tracker write. Reading a tracker item is allowed.
- Never ask the developer to type an approval phrase. A checkpoint is one question with buttons, raised with the question dialog.
- Never print or store a secret. Never copy a customer's name or data into a file.
- If a command prints `{"error": ...}`, say what it says in plain words. For `no-pod` or `no-work-dir` the set-up is not finished: offer `/pod-harness:setup`.
- If the developer gives a home folder for testing, start every command with `POD_HARNESS_HOME="<folder>"` in Bash. In PowerShell run `$env:POD_HARNESS_HOME = '<folder>'` once first.
- Keep your own messages short.

## Continuing a task

If the request starts with `resume ` and a task id, a task is already running. Skip Plan mode, Intake and Start, and go to the Loop with that id.

If words follow the task id, they are the developer's answer. When the task shows a question, or is `blocked`, send them as the change note without asking again.

## Plan mode

If Claude's Plan mode is on, run nothing that writes: no `start`, no file. Do the Intake step, then present the restated request and the path you predict through Claude's own plan approval. Go on to Start only after the developer approves the plan.

If `next` later prints a `fix` that says Plan mode is on, tell the developer to leave Plan mode. The task goes on after that.

## 1. Intake

1. Restate the request in at most eight lines: what is asked, where, and what done looks like.
2. Find the repo. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" show` and read `config.repos`. Find the place to change with at most one search. Do not read the code: the agents do that.
3. Predict the path:
   - `trivial`: one repo and the place are known, and the request is one obvious change with no design choice.
   - `small`: one repo and the place are known, but the change is not trivial.
   - `full`: anything else.
4. The developer can overrule you. "Treat this as trivial" means `trivial` with `--force`. "Run the full path" means `full`.

## 2. Start

Run one of these. Use `--item` when the request names a work item, otherwise `--name` with a few words in quotes. Give `--repo` and `--place` once for each one you found.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" start --item <id> --predict <trivial|small|full> --repo <name> --place <path in the repo> --session ${CLAUDE_SESSION_ID}
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" start --name "<short name>" --predict <trivial|small|full> --repo <name> --place <path in the repo> --session ${CLAUDE_SESSION_ID}
```

- `problems`: nothing was started. Show each problem with its `fix` and offer to run that set-up step now. Then run `start` again.
- `reason`: the script changed your prediction. Tell the developer in one line.
- Otherwise it prints `id`, `dir` (the task folder), `request_file` and `item_file`.

Then write the request to `request_file`, under three headings: What is asked, Where, Done when.

If the request names a work item and the pod has a tracker: read the item with the tracker tools this session has, read-only. Write its title, description and acceptance criteria to `item_file`. Leave out customer names and customer data. If the tracker cannot be read, say so and go on without `item_file`.

## 3. Loop

Run this, then act on `action.type`. Repeat until `end`.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" next <id> --session ${CLAUDE_SESSION_ID}
```

If the output has a `note`, show it once.

| `action.type` | What you do |
| --- | --- |
| `dispatch` | Take the waves in order. For one wave, make one Agent call per entry, all in one message: `subagent_type` is the entry's `agent`, `model` is its `model`, `effort` is its `effort` when it has one, and `prompt` is its `prompt` exactly as given. Then wait until every agent of the wave has finished, not only started: an Agent call can return while its agent still works, and you are told when it finishes. Only then start the next wave. After the last wave has finished, run `next` again. |
| `run` | Run `command` in the background. When it ends, run `next` again. |
| `wait` | Show `message`. Something is still running: the tests, or agents. Run `next` again when it has finished. If you cannot tell when that is, run `next` again after a minute. |
| `ask` | Raise the checkpoint, as below. |
| `fix` | Show each problem with its `fix`. When the developer has fixed it, run `next` again. |
| `end` | Show `lines`. With the status `done` the task is over: stop. With the status `blocked` the task waits for the developer: see "A blocked task" below. |

### A checkpoint

Print `summary` exactly as given: it is markdown. Then raise one question with the question dialog: `header`, `question` and the `options`, exactly as given. There are two or three options. Then run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" answer <id> <checkpoint> <continue|change|stop>
```

- "Continue" is `continue`. Run `next` again.
- "Continue with a change" is `change`. Take the developer's own words. If they gave none, ask once, in one line. Write them to a new note file in the task folder (`dir` in what `next` prints), such as `change-1.md`. Add the note to the command as `"@<full path of the note>"`, with the quotes: both shells accept that form. Run `next` again.
- "Stop here" is `stop`. Do not run `next`. Say that `/pod-harness:resume <id>` continues the task.

An option that is not offered is never sent. A "Needs you" question is the task saying it cannot go on by itself: it shows why, and what the agents ask.

### A blocked task

A task is `blocked` when it needs the developer and nothing may be asked, as under Bypass permissions. Show `lines`: they say why it stopped. Do not guess an answer. When the developer says what should happen, write their words to a new note file in the task folder and run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" answer <id> needs_you change "@<full path of the note>"
```

Then run `next` again: the stage that stopped runs again with the note.

### Asking nothing

If the developer says to ask nothing for this task, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.js" quiet <id> on`. Checkpoints are then logged and not asked. `off` turns it back.

### Clearing the session

Say once, after the first stage has finished: the session can be cleared between stages, and `/pod-harness:resume <id>` continues the task. Everything the task needs is in its folder.
