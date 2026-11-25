# pod-harness

A Claude Code plugin that gives a pod one way of working with Claude Code. A guided set-up collects the pod's repos, build and test commands, policies and stage checkpoints, and stores them on your machine. A pod lead can export that set-up as one file for the team. `/pod-harness:task` then runs a task through the pod's stages with that set-up.

This is version 0.2.1: the set-up, and a task from intake to review. Design, planning and delivery come in later versions.

## Install

In Claude Code:

1. `/plugin marketplace add carlosmontoya-bigchange/AgentsOrchestrator` (a public repo: you need no access to it)
2. `/plugin install pod-harness@agents-orchestrator`
3. `/reload-plugins`

It needs Claude Code 2.1.292 or later, Node 20 or later, and git on the PATH.

To update from an earlier version: `/plugin marketplace update agents-orchestrator`, then `/plugin install pod-harness@agents-orchestrator` and `/reload-plugins`.

## Commands

| Command | What it does |
| --- | --- |
| `/pod-harness:setup` | The guided set-up, twelve short steps. With a base file from your pod lead it asks only for what is local to your machine. |
| `/pod-harness:setup <part>` | Changes one part: `pod`, `repo <path>`, `teams`, `trivial`, `policies`, `approvals`, `delivery`. |
| `/pod-harness:doctor` | Checks the set-up, says what is missing and how to fix it, and shows where you differ from the pod base. |
| `/pod-harness:doctor agents` | The same check, and it also starts each agent model once to see that it answers. |
| `/pod-harness:export` | Pod leads: writes the pod base to one markdown file to share with the team. |
| `/pod-harness:task <request>` | Runs one task through the pod's stages: understand, build, test, review. |
| `/pod-harness:resume [id]` | Continues a task after a cleared session or a stop. With no id it lists the open tasks. |

## How much the harness asks

The harness has no approval switch of its own, and it never asks you to type an approval phrase. It follows the permission mode you pick in Claude.

- A push, a PR, a tracker write and the like use Claude's own permission prompts, exactly as outside the harness.
- A stage checkpoint is a question with buttons at the end of a stage. The pod chooses which of the four it uses: work order, design, plan and review result (`Approvals`).
- Manual and Accept edits: every checkpoint is asked. Auto: only when there is something to decide. Plan: Claude's own plan approval. Bypass permissions: nothing is asked, and it is logged.
- A pod that needs a hard rule lists it under `Delivery` as `never` or `always_ask`, in Claude Code's permission rule syntax. The set-up offers to add those rules to your own Claude Code settings, where they hold in every mode.

Four more checkpoints always exist: a task that grew, a stage that used its budget, something a policy needs your yes for, and a task that cannot go on by itself ("Needs you"). If the mode cannot be read, every checkpoint is asked. You can tell the session to ask nothing for one task. Every checkpoint, asked or not, is written to the task's `approvals.log`.

## How a task runs

`/pod-harness:task <what to do, or a work item id>` takes one request through the pod's stages. A script decides each step, agents do the work, and every stage leaves a report on disk.

| Stage | What happens |
| --- | --- |
| Intake | The session restates the request and predicts its path: trivial, small or full. |
| Understand | The Orchestrator sizes the task (S, M or L) and writes the work order: which specialist builds what, in which repo. The Explorer finds the code first, so nobody searches twice. |
| Build | One specialist per repo and kind (backend, frontend, database) makes the change with its automated tests, on a task branch. |
| Test | A script runs the build and test commands of the repos that changed. The Tester is called only when something fails, or when the work order lists a check no script can run. |
| Review | The Reviewer reads the diff against the pod's policies, the work item and the test evidence, and lists what a person must test by hand. |
| Close | The session says where the work is and what is left open. |

- **The fast path.** A trivial change skips Understand: one specialist, the tests, and the Reviewer on a cheaper model. After Build a script measures the change. More than the pod's limits (by default 3 product files, 50 product lines, 150 test lines), a "never trivial" path or a sensitive change moves the task to the full path, and you are told why.
- **The branch.** Build works in the repo's own folder on a branch named by the pod (`task/{id}` by default), cut from the fetched trunk. It will not start on uncommitted changes that sit on another branch. In this version the work stays uncommitted on that branch: you commit, push and open the pull request yourself.
- **The task folder.** Everything is in `<work folder>/<task id>/`: the request, `state.json`, the work order, one brief and one report per agent, a `stage-report.md` per stage, the test result, `approvals.log` and `task.md`, the running summary. You can clear the session between stages: `/pod-harness:resume` continues from these files.
- **Loops.** Failing tests go back to Build twice, then once to the Orchestrator for a new plan. A review that asks for changes goes back to Build twice. After that the task asks you ("Needs you") and names the evidence. Your answer, in your own words, runs the stage again with a fresh set of rounds.
- **Questions and notes.** An agent's report keeps two lists apart: questions, which only you can decide, and notes for later. Only a question makes Auto ask. A checkpoint is a short summary followed by a one-line question; the full report stays in the task folder.
- **Needs you.** When a task cannot go on by itself, it asks: the Orchestrator or a Build agent needs a decision, Build changed nothing, or a loop is used up. Where nothing may be asked, as under Bypass permissions, the task waits as `blocked`, and `/pod-harness:resume <id>` with what should happen starts it again. Nothing is guessed.
- **Permission prompts.** Agents take the permission mode of your session. The harness sets none of its own.
- **The commands of a repo** run as you would type them, through `cmd.exe` on Windows and `/bin/sh` elsewhere, with a limit of 30 minutes for each.
- **The hook.** The plugin has one hook. On a prompt, on an agent starting and on an agent finishing it writes the permission mode Claude reports to the task's `mode.json`, so a checkpoint knows how much to ask. After a compaction it reminds the session which task it was on. It never blocks anything, and in a session with no pod-harness task it does nothing.

Not in this version: the Design and Plan stages (an M or L task goes from the work order straight to Build, and the checkpoint says so), the Deliver stage, budgets and token counts, and memory between tasks.

## Where the files live

Everything is in `~/.pod-harness/` on your machine, outside every repo. Nothing there is pushed anywhere, and it survives an uninstall of the plugin.

```
~/.pod-harness/
  active.json          which pod this machine uses, and whether it wrote the base or imported it
  <pod>/base.md        the pod's shared settings (imported from the pod lead, or written by them)
  <pod>/personal.md    your own changes and everything local: repo folders, the work folder, proof that commands run
```

The configuration has three layers. The later one wins:

1. Org defaults, inside the plugin (`defaults/defaults.md`).
2. The pod base, `base.md`.
3. Your personal file, `personal.md`.

No secret is ever stored. Where a command or a webhook needs one, the configuration holds the name of an environment variable.

## The file format

`base.md` and `personal.md` are markdown. Each has a header and, under fixed headings, one `json` block with that section's settings. You can write notes anywhere outside the blocks; they are kept.

````markdown
---
format: 1
min_plugin: 0.1.0
layer: base
pod: example
---

# Pod

```json
{ "name": "example", "tracker": { "type": "none" } }
```

# Repos

```json
[ { "id": "dev.azure.com/org/proj/_git/app", "name": "App", "trunk": "main",
    "build": "dotnet build App.slnx", "test": "dotnet test App.slnx",
    "env": ["NUGET_TOKEN"], "specialists": [ { "glob": "**", "agent": "backend" } ] } ]
```
````

- Headings: `Pod, Repos, Stages, Teams, Reports, Trivial, Policies, Skills, Approvals, Delivery, Budget`. A file may leave any out.
- A repo's `id` is its remote, written as host and path in lower case, so the same base file fits any folder layout.
- A command is a string, an object with one command per system (`win32`, `linux`, `darwin`), or `"none"`.
- `Repos` and `Policies` are lists of records with an `id`. A personal record with the same `id` changes the base record. `"off": true` removes it. `null` removes one setting.
- A base file may not hold a repo's `path` or `proof`, or the work folder. Those belong to one machine.

Use the commands to change settings. Editing by hand works, and `/pod-harness:doctor` tells you if a file no longer reads.

## Limits

- No Design, Plan or Deliver stage yet, and no commit, push, pull request or tracker update by the harness.
- One task at a time in a repo: Build uses the repo's own folder, not a worktree.
- The environment check covers what a script can read: Node, git, the Claude Code version and two environment variables. The models and the nesting of agents are probed by the set-up and by `/pod-harness:doctor agents`.
- Tokens are not counted yet, so no budget is enforced. Budget, team and turn numbers in the defaults are provisional.

## Tests

`node --test` from this folder.
