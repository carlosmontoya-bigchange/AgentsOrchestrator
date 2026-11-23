# pod-harness

A Claude Code plugin that sets up how a pod works with Claude Code. A guided set-up collects the pod's repos, build and test commands, policies and approvals, and stores them on your machine. A pod lead can export that set-up as one file for the team.

This is phase 1: set-up only. The stages and agents that use the configuration come in later versions.

## Install

In Claude Code:

1. `/plugin marketplace add carlosmontoya-bigchange/AgentsOrchestrator` (a private repo: your git must be able to clone it)
2. `/plugin install pod-harness@agents-orchestrator`
3. `/reload-plugins`

It needs Node 20 or later and git on the PATH.

## Commands

| Command | What it does |
| --- | --- |
| `/pod-harness:setup` | The guided set-up, twelve short steps. With a base file from your pod lead it asks only for what is local to your machine. |
| `/pod-harness:setup <part>` | Changes one part: `pod`, `repo <path>`, `teams`, `trivial`, `policies`, `approvals`, `delivery`. |
| `/pod-harness:doctor` | Checks the set-up, says what is missing and how to fix it, and shows where you differ from the pod base. |
| `/pod-harness:export` | Pod leads: writes the pod base to one markdown file to share with the team. |

## Where the files live

Everything is in `~/.pod-harness/` on your machine, outside every repo. Nothing there is pushed anywhere, and it survives an uninstall of the plugin.

```
~/.pod-harness/
  active.json          which pod this machine uses
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

- Phase 1 sets up only. Nothing runs tasks yet.
- The environment check covers what a script can read: Node, git and two environment variables. Claude Code's version and models are checked when the agents arrive.
- Budget and team numbers in the defaults are provisional.

## Tests

`node --test` from this folder.
