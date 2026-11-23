---
name: setup
description: Guided set-up for the pod harness. Use when someone wants to set up or change how their pod works with Claude Code: repos and their build and test commands, stages, team limits, policies, approvals, or who performs outward actions. Also use for "/pod-harness:setup <part>" to change one part.
---

# Pod harness set-up

You are guiding a developer through setting up their pod's configuration. The configuration lives in `~/.pod-harness/` on their machine, in three layers: org defaults (inside the plugin), the pod base (`base.md`, shared by the pod lead as a file) and personal settings (`personal.md`).

## Rules

- Do everything through the CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" <command>`. Each command prints one JSON document. Act on what it prints.
- Never write or edit `base.md` or `personal.md` yourself. Only the CLI writes them.
- Never ask for, print or store a secret: no passwords, tokens, keys or webhook URLs. Where a command needs one, ask only for the **name** of the environment variable that holds it.
- Ask one question at a time. Give each question a proposed answer the developer can accept.
- Never ask for something a command already told you.
- If a command prints `{"error": ...}`, tell the developer what it says in plain words, then fix the input or ask. An error that names a `heading` is about that heading of the file.
- Pass JSON to `set` in single quotes with the Bash tool. If only PowerShell is available, write the JSON to a file in your scratch folder and pass `@<file>` in its place.
- If a value contains a backslash, such as an Azure DevOps area path (`BigChange\Finance\Midas`), always write the JSON to a file and pass `@<file>`: the shell changes backslashes on a command line. In the file, write each backslash twice, as JSON needs.
- If the developer gives a home folder for testing, start every command with `POD_HARNESS_HOME=<folder>`.
- Keep your own messages short. Say which step you are on ("Step 3 of 12: repos").

## Which layer an answer goes to

- These always go to `personal`: a repo's local `path`, a repo's `proof`, and the work folder (`work_dir`).
- **Author mode** (no base file was imported; the developer is writing the pod's base): every other answer goes to `base`.
- **Member mode** (a base file was imported): every other answer goes to `personal`, and only if the developer wants something different from the base.

Below, `<layer>` means the layer this rule gives.

The mode is stored, so you never have to guess it. When you did not just run step 2 yourself (a new session, or `/pod-harness:setup <part>`), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" show` first and read `role`: `author` or `member`. If it prints the error `no-pod`, nothing is set up yet: run all twelve steps.

## Running one part

With an argument, run only that part, then show the result of step 12 for it:

| Command | Steps |
| --- | --- |
| `/pod-harness:setup pod` | 2 and 4 |
| `/pod-harness:setup repo <path>` | 3 and 6, for that one repo (`detect <path>`) |
| `/pod-harness:setup teams` | the team limits and models in step 4 |
| `/pod-harness:setup trivial` | 8 |
| `/pod-harness:setup policies` | 9 |
| `/pod-harness:setup approvals` | 10 |
| `/pod-harness:setup delivery` | 11 |

With no argument, run all twelve steps in order.

## The steps

### 1. Environment

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" env-check`. Show each check that is not `ok` with its `fix`. Stop only if `node` or `git` failed. For the others, say what to change and carry on.

### 2. Mode

Ask: "Do you have a base file from your pod lead?" (proposed: no).

- Yes: ask for its path, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" import <file>`. If it prints `problems`, show them and stop: the pod lead must fix the file. Otherwise you are in member mode.
- No: ask for the pod's name, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" init <pod>`. You are in author mode.

### 3. Repos

Ask which folder holds the pod's repos (proposed: the folder this session is in, or its parent if the session is inside one repo).

Write every folder path in JSON with forward slashes (`C:/dev/app`, not `C:\dev\app`): a backslash changes the path.

Both commands below also print `duplicates`: folders that hold the same remote as another one, such as a linked worktree beside its main clone. One folder per remote is kept. Tell the developer which folder was kept and which were left out, and ask whether that is the right one. To use another, store its path in `personal` yourself.

**Member mode.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" match <folder>`.
- For each `matched` repo, store its path: `set personal Repos '[{"id":"<id>","path":"<path>"}]'`.
- List `notCloned` repos. They are not an error; say they can be added later with `/pod-harness:setup repo <path>`.
- List `extra` repos and ask whether to add any for this developer only. If yes, treat each as in author mode but store it in `personal`.

**Author mode.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" detect <folder>`. For each repo, show what was detected and ask the developer to confirm or correct it, one repo at a time:
- name, trunk branch, build command, test command. A `null` means nothing was detected: ask. If the repo has no build or no test, store `"none"`.
- which specialist owns which folders (`specialists`: the first matching glob wins; agents are `backend`, `frontend`, `database`).
- "Does the build or test need an environment variable, such as a feed token? Give me the names only." Store the names in `env`.
- If the pod works on more than one operating system and a command differs, store it per system: `{"win32": "...", "linux": "...", "darwin": "..."}`.

A repo whose `id` is `null` has no `origin` remote. It cannot be shared in a base file; say so and skip it.

Store the shared part and the local part separately:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set base Repos '[{"id":"<id>","name":"<name>","trunk":"<trunk>","build":"<command>","test":"<command>","env":[],"specialists":[{"glob":"**","agent":"backend"}]}]'
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set personal Repos '[{"id":"<id>","path":"<path>"}]'
```

`set` prints `problems` for the section it changed. If there are any, fix them with the developer before moving on.

### 4. Pod, stages, teams and the work folder

Author mode, one question each:
- The tracker: `azure-devops`, `github` or `none`. For `azure-devops`, the area path. A pod with no tracker answers `none`, and the harness skips tracker steps.
- Optional: links to the wiki pages that explain how to get access to git and to the tracker. Store them as `help`.
- Which stages run. Proposed: all of Design, Plan, Test, Review and Deliver. Switch one off only if another team does that part.
- Team limits. Proposed: the defaults from `show` (`teams.max_agents_per_stage`, `teams.max_same_kind`). Change `teams.models` only if the developer asks.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set base Pod '{"name":"<pod>","tracker":{"type":"azure-devops","area_path":"<path>"},"help":{"git":"<link>","tracker":"<link>"}}'
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set base Stages '{"design":true,"plan":true,"test":true,"review":true,"deliver":true}'
```

Member mode: skip those questions unless the developer wants to differ from the base.

Everyone: ask where task reports go (proposed: `<repos folder>/work`). It must be outside every repo's history. Store it with `set personal Reports '{"work_dir":"<folder>"}'`.

### 5. Access

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" doctor` and look at `access`.
- Show each remote that is not `ok` with its `fix`, and `pod.help.git` if it is set.
- Tracker: if the type is `azure-devops` or `github`, make one read-only call with the tracker tools this session has (for example, list the project). If the session has no such tools or the call fails, say the tracker connection is missing and show `pod.help.tracker` if it is set.
- Skills: for every skill named under `skills` in the configuration, check that this session lists it. Report any that is missing.

A failed check does not stop set-up. Say what will not work until it is fixed.

### 6. Prove the commands

Run `show`. Show the exact build and test command for each repo that has a path, in a table, before anything runs. In member mode, say plainly that these commands come from the pod lead's base file and will run on this machine. Never run a command the developer has not seen.

Then tell the developer this runs each repo's real build and tests once and may take minutes. Ask whether to run them now (proposed: yes). On a no, skip to step 8: nothing is proven and no permission rule is offered.

For each repo that has a path, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" prove <id>` and show `build` and `test`.
- `missing_env`: name the variables that are not set. Never ask for their values. The developer sets them and you run `prove` again.
- `fail`: show the end of `tail`. Offer two choices: correct the command (store it with `set <layer> Repos`, then `prove` again), or record that it does not run on this machine:
  `set personal Repos '[{"id":"<id>","proof":{"build":"not-run","test":"not-run","at":"<time now, ISO>"}}]'`.
- `not-run` from a timeout: the command took more than ten minutes. Record it as above and say so.

### 7. Permissions

Offer to add allow rules for the build and test commands that passed in step 6 to the developer's Claude Code settings, so agents are not stopped by a permission prompt on every run (proposed: yes). List the exact commands the rules would allow. Only on a yes: use the `update-config` skill if this session has it. Otherwise show the rules for the developer to add by hand. Add nothing else.

### 8. Trivial paths

A change that touches a "never trivial" path always takes the full route. Run `show` and read `trivial.never`. For each glob, use the Glob tool to count the files it matches in each repo, and show the counts in a table. Ask whether to add or remove globs (proposed: keep them). To change the list, store the whole new list: `set <layer> Trivial '{"never":["<glob>","<glob>"]}'`.

### 9. Policies

Explain in one line: a policy is a rule the pod works by, stored as one line plus a link to the wiki page with the full text. Member mode: show the base's policies and ask only whether to add or switch off any for this developer.

Author mode: ask, one at a time, for the link and a one-line statement for each of these, skipping any the pod does not have: Definition of Done, Definition of Ready, branching, review rules, database rules. Then ask whether there are others.

For each, ask how it is upheld (proposed: `review`):
- `approval`: the agent asks the developer before the action.
- `review`: the agent doing the work is told the policy, and the Reviewer checks it.

Also ask where it applies: a stage (`design`, `plan`, `build`, `test`, `review`, `deliver`), an agent, or `all`.

If the link is a wiki page and the tracker tools are connected, open it once to check it exists. Otherwise mark it "not checked" in your summary. Never copy the page's text into the configuration.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set <layer> Policies '[{"id":"pod-dod","statement":"<one line>","applies_to":"review","check":"review","source":"https://<link>"}]'
```

Give each policy a short id starting with `pod-`. To switch a policy off for one developer: `set personal Policies '[{"id":"<id>","off":true}]'`.

### 10. Approvals

Explain: an approval is a question the harness asks before it goes ahead. Any of them can be switched off, and the stages still run in the same order. An action taken without asking is written to the task's log.

Ask with the question dialog which approvals are on:
- **All on** (proposed): every key `true`.
- **Outward actions only**: `outward_action` is `true`, the other eight are `false`.
- **All off**: every key `false`.
- **Choose one by one**: ask about each.

The nine keys and what each asks before:

| Key | Asks |
| --- | --- |
| `work_order` | after the task is sized and routed |
| `design` | after the design |
| `plan` | after the build plan |
| `review_result` | after the review |
| `outward_action` | before a push, PR, tracker write, pipeline run, message or webhook call |
| `destructive_local` | before deleting files or branches, or discarding uncommitted work |
| `policy_exception` | when an agent cannot meet a policy and proposes to go ahead anyway |
| `budget_reached` | when a stage has used its budget |
| `task_grew` | when a task turns out bigger than first judged |

Store all nine: `set <layer> Approvals '{"work_order":true,"design":true,"plan":true,"review_result":true,"outward_action":true,"destructive_local":true,"policy_exception":true,"budget_reached":true,"task_grew":true}'`.

### 11. Delivery

Ask, one at a time:
- Who performs outward actions such as a push or a PR: the main session (`main`, proposed) or the Delivery Specialist agent (`agent`).
- Where manual test cases go (for example a test plan in the tracker, or "none").
- Whether the pod posts to a webhook. If yes, ask for a short name and the **name of the environment variable** that holds its URL. Never the URL.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set <layer> Delivery '{"actor":"main","manual_tests":"<where>","webhooks":[{"id":"teams","env":"TEAMS_WEBHOOK_URL"}]}'
```

### 12. Summary

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" show` and `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" doctor`. Show:
- a short table: pod, tracker, each repo with its trunk and proof, stages that run, approvals that are on, who delivers;
- every entry in `problems` with level `error`, each with the command that fixes it: `/pod-harness:setup <step>`;
- entries with level `info` in one line each (for example, a repo that is not cloned);
- in member mode, `differs`: where this developer's settings differ from the pod base.

Then say what comes next. Author mode: "Run `/pod-harness:export` to write the base file for your team." Member mode: "You are set up. Run `/pod-harness:doctor` any time to check."
