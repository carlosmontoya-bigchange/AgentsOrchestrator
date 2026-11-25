---
name: setup
description: Guided set-up for the pod harness. Use when someone wants to set up or change how their pod works with Claude Code: repos and their build and test commands, stages, team limits, policies, stage checkpoints, or who performs outward actions. Also use for "/pod-harness:setup <part>" to change one part.
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
- Pass JSON to `set` in single quotes with the Bash tool. If only PowerShell is available, write the JSON to a file in your scratch folder and pass `"@<file>"` in its place, with the quotes: PowerShell reads a bare `@` as something else.
- If a value contains a backslash, such as an Azure DevOps area path (`BigChange\Finance\Midas`), always write the JSON to a file and pass `@<file>`: the shell changes backslashes on a command line. In the file, write each backslash twice, as JSON needs.
- If the developer gives a home folder for testing, start every command with `POD_HARNESS_HOME="<folder>"` in Bash. In PowerShell run `$env:POD_HARNESS_HOME = '<folder>'` once first.
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

Then probe the agents. Say first that this costs a few small agent runs.
- Dispatch `pod-harness:explorer` once for each model the harness uses, `haiku`, `sonnet` and `opus`, passing that model, with the prompt `Reply with the single word: ready`. A model that does not answer cannot run the agents set to it: name it.
- Dispatch `pod-harness:orchestrator` with the model `haiku` and the prompt `Dispatch the pod-harness:explorer agent with the prompt 'Reply with the single word: ready' and return its reply.` If `ready` comes back, an agent can start another agent. If not, say that the Orchestrator cannot start the Explorer on this machine and show the `spawn-depth` check.

Report each model that did not answer and whether nesting works. Neither stops set-up.

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
- "Which skills should each agent use?" Show the skills this session lists. Proposed: none. An agent's brief then names its skills. Store them per agent: `set base Skills '{"backend":["<skill>"]}'`.

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

Then tell the developer this runs each repo's real build and tests once and may take minutes. Ask whether to run them now (proposed: yes). On a no, nothing is proven: go to step 7, which then offers only the pod's rules.

For each repo that has a path, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" prove <id>` and show `build` and `test`.
- `missing_env`: name the variables that are not set. Never ask for their values. The developer sets them and you run `prove` again.
- `fail`: show the end of `tail`. Offer two choices: correct the command (store it with `set <layer> Repos`, then `prove` again), or record that it does not run on this machine. Record only the command that does not run, with the value `"not-here"`:
  `set personal Repos '[{"id":"<id>","proof":{"test":"not-here","at":"<time now, ISO>"}}]'` (use `"build"` for the build command, and both when neither runs here).
  The Test stage of a task then skips that command and says so at the Review checkpoint. `not-run` is not that record: it only says the set-up did not get as far as running the command, and a task will run it.
- `not-run` from a timeout: the command took more than ten minutes. Offer the same record and say so.

### 7. Permissions

This step offers rules for the developer's own Claude Code settings. Write a rule only on a yes: use the `update-config` skill if this session has it, otherwise show the rules for the developer to add by hand. Add nothing else.

- **Allow rules.** Offer to allow the build and test commands that passed in step 6, so agents are not stopped by a permission prompt on every run (proposed: yes). List the exact commands the rules would allow. If nothing was proven, offer none. A rule in your user settings holds at once. A rule in a project settings file that did not exist before holds from the next session.
- **The pod's rules.** Run `show` and read `delivery.never` and `delivery.always_ask`. If both are empty, say nothing about them. Otherwise list them and offer to add them (proposed: yes): `delivery.never` as deny rules, `delivery.always_ask` as ask rules. Before you write one, say that both hold in every permission mode, Bypass permissions included: a "never" rule blocks the action, and an "always ask" rule shows Claude's own prompt.

### 8. Trivial paths

A change that touches a "never trivial" path always takes the full route. Run `show` and read `trivial.never`. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" trivial-count` and show its counts in a table: how many tracked files each glob matches in each repo. Show only the globs that match at least one file, and say in one line how many globs match nothing. Say that globs ignore case, so `**/migrations/**` also matches a `Migrations` folder. Ask whether to add or remove globs (proposed: keep them). To change the list, store the whole new list: `set <layer> Trivial '{"never":["<glob>","<glob>"]}'`.

### 9. Policies

Explain in one line: a policy is a rule the pod works by, stored as one line plus a link to the wiki page with the full text. Member mode: show the base's policies and ask only whether to add or switch off any for this developer.

Author mode: ask, one at a time, for the link and a one-line statement for each of these, skipping any the pod does not have: Definition of Done, Definition of Ready, branching, review rules, database rules. Then ask whether there are others.

For each, ask how it is upheld (proposed: `review`):
- `approval`: the main session asks the developer before the action, when their permission mode calls for a question (step 10).
- `review`: the agent doing the work is told the policy, and the Reviewer checks it.

Also ask where it applies: a stage (`design`, `plan`, `build`, `test`, `review`, `deliver`), an agent, or `all`.

If the link is a wiki page and the tracker tools are connected, open it once to check it exists. Otherwise mark it "not checked" in your summary. Never copy the page's text into the configuration.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set <layer> Policies '[{"id":"pod-dod","statement":"<one line>","applies_to":"review","check":"review","source":"https://<link>"}]'
```

Give each policy a short id starting with `pod-`. To switch a policy off for one developer: `set personal Policies '[{"id":"<id>","off":true}]'`.

### 10. Checkpoints

Explain, in a few lines. Name the modes as the developer's app shows them.
- The harness has no approval switch of its own and never asks anyone to type an approval phrase. How much it asks follows the permission mode the developer has picked in Claude.
- A push, a PR, a tracker write and the like are covered by Claude's own permission prompts, exactly as outside the harness.
- A checkpoint is a question with buttons at the end of a stage. In Manual and Accept edits every checkpoint is asked. In Auto one is asked only when there is something to decide. In Plan mode Claude's own plan approval takes its place. Under Bypass permissions nothing is asked, and each skipped checkpoint is logged.
- The stages run in the same order in every mode.

**Author mode.** Ask with the question dialog which stage checkpoints the pod uses:
- **All four** (proposed): every key `true`.
- **Design and plan only**: `design` and `plan` are `true`, the other two are `false`.
- **None**: every key `false`.
- **Choose one by one**: ask about each.

| Key | Asked |
| --- | --- |
| `work_order` | after the task is sized and routed |
| `design` | after the design |
| `plan` | after the build plan |
| `review_result` | after the review |

Store all four: `set base Approvals '{"work_order":true,"design":true,"plan":true,"review_result":true}'`.

Say that three more checkpoints always exist and are not a setting: a task that grew, a stage that used its budget, and a policy an agent cannot meet.

**Member mode.** Ask nothing. Show which checkpoints the pod uses (`approvals` in `show`) and say that the permission mode picker in Claude decides how much is asked. Only when the developer ran `/pod-harness:setup approvals` themself and wants to differ from the pod, store their choice in `personal`.

### 11. Delivery

Ask, one at a time:
- Who performs outward actions such as a push or a PR: the main session (`main`, proposed) or the Delivery Specialist agent (`agent`).
- Where manual test cases go (for example a test plan in the tracker, or "none").
- Author mode only: the name pattern for task branches (proposed: `task/{id}`). It must contain `{id}`, which becomes the task's id. The Build stage works on that branch in each repo. Store it as `branch`.
- Whether the pod posts to a webhook. If yes, ask for a short name and the **name of the environment variable** that holds its URL. Never the URL.
- Author mode only: whether the pod has outward actions that must never happen, or must always be confirmed, whatever permission mode a developer uses (proposed: none). Give two examples: never a force push; always confirm a pipeline run. Write each as a Claude Code permission rule, `Tool` or `Tool(pattern)`, such as `Bash(git push --force *)`. A rule matches the command as written, so `git push -f` needs its own rule. Store the lists as `never` and `always_ask`.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" set <layer> Delivery '{"actor":"main","branch":"task/{id}","manual_tests":"<where>","webhooks":[{"id":"teams","env":"TEAMS_WEBHOOK_URL"}],"never":["Bash(git push --force *)"],"always_ask":[]}'
```

The harness does not enforce these two lists. They become rules in each developer's own Claude Code settings, offered in step 7. If the developer just gave any, offer them for their own settings now, as step 7 describes.

### 12. Summary

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" show` and `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" doctor`. Show:
- a short table: pod, tracker, each repo with its trunk and proof, stages that run, the stage checkpoints the pod uses, who delivers, the pod's "never" and "always ask" rules;
- every entry in `problems` with level `error`, each with the command that fixes it: `/pod-harness:setup <step>`;
- entries with level `info` in one line each (for example, a repo that is not cloned);
- in member mode, `differs`: where this developer's settings differ from the pod base.

Then say what comes next. Author mode: "Run `/pod-harness:export` to write the base file for your team." Member mode: "You are set up. Run `/pod-harness:doctor` any time to check."
