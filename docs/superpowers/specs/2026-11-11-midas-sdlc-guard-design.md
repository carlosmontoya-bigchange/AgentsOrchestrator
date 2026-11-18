# Guard design: midas-sdlc outward-action guard

This file holds the technical design behind the guard requirements in the [harness spec](2026-11-11-midas-sdlc-harness-design.md), R18 to R33 and R56. The spec says what the guard does; this file says how. When they disagree, the spec wins and this file is fixed.

**Threat model.** The guard stops Claude's mistakes and instructions injected through content Claude reads. It does not stop a determined attacker with shell access. Branch policies in Azure DevOps stay the backstop for protected branches. midas/dev has no policy, so the guard is its only check.

## Hooks

| Event | Matcher | Script | Timeout | On failure | Does |
| --- | --- | --- | --- | --- | --- |
| UserPromptSubmit | all | record.js | 10 s | continue | Compares the input's `prompt_id` with the last one seen in the session, then deletes the arm. A repeat `prompt_id` stops there: nothing is parsed or written. Otherwise it parses the message and writes the arm, the ledger and the item's gates.log. Tells Claude what is armed, or that the answer wasn't understood. Never blocks a prompt. |
| PostToolUse | `^mcp__azure-devops__(repo_pull_request_write\|wit_work_item_write\|testplan_test_case_write)$` | record.js | 10 s | continue | Records ids returned by create calls into the arm and the ledger |
| PreToolUse | `^mcp__(plugin_agentic-midas_)?azure-devops__.*$` | guard.js | 10 s | block | Azure DevOps rules |
| PreToolUse | `^(Bash\|PowerShell\|Monitor\|mcp__terminal__run_in_terminal)$` | guard.js | 10 s | block | Shell rules |
| PreToolUse | `^(Write\|Edit\|NotebookEdit\|Artifact)$` | guard.js | 10 s | block | Path rules |
| PreToolUse | `^mcp__(claude-in-chrome\|Claude_Browser)__.*$` | guard.js | 10 s | block | Browser rules |
| PreToolUse | `^(SendMessage\|CronCreate\|RemoteTrigger\|PublishPlugin\|mcp__ccd_session__(start_session\|hand_off_to_session\|move_to_cloud)\|mcp__ccd_session_mgmt__(send_message\|set_remote_control\|set_session_permission_mode)\|mcp__ccd_settings__set_setting\|mcp__scheduled-tasks__(create\|update)_scheduled_task)$` | guard.js | 10 s | block | Session, schedule and app-setting rules |

- **Runtime.** Hooks run Node 24 in exec form (`"command": "node"`, with the script path in `args`) and have no dependencies.
- **Input.** They read stdin with a one-second fallback and strip a byte-order mark.
- **Output.** guard.js only ever outputs `deny`, with a reason naming the approval needed, or nothing. It never outputs `allow` or `ask`.
- **Fallback.** guard.js has a tiny entry that loads the rules inside try/catch. If the rules fail to load or throw, the entry still applies its own checks. Words such as `push` and `claude` match as whole words, not substrings. Azure DevOps hosts and `@azure-devops` match anywhere in the text. The entry denies:
  - a file tool path or shell text naming an always-denied or harness path, reads included (for example `node --test` on the harness tests);
  - every Azure DevOps tool outside the read allowlist;
  - session and message tools whose text has a line matching an answer;
  - PublishPlugin and the setting tools (`set_remote_control`, `set_session_permission_mode` and `set_setting`);
  - browser calls naming an Azure DevOps host;
  - shell text with the word `push` or `claude`, or naming `dev.azure.com`, `visualstudio.com` or `@azure-devops`.

  Everything else passes. The way out of a fallback deny is switching the plugin off with the README recovery steps (see [Recovery](#recovery)).
- **Activation.** The shell and path rows go live in shadow mode first. guard.js runs with `--shadow` and onFailure continue, in sessions inside and outside the workspace. In shadow mode it denies nothing and appends each deny it would have made to `${CLAUDE_PLUGIN_DATA}/shadow.jsonl`. Each false deny is fixed, and the window then starts again. After a full window with no false deny, both rows drop `--shadow` and use onFailure block.

  Shadow window: one full working day

## Answers

An answer is any message the recorder acts on. The recorder reads the whole trimmed message as the app delivers it.

- **App context.** When a doc pane is open, the app puts one `<artifact-view-context>` block before the developer's words. The recorder strips exactly one such leading block before parsing, because it's app context. Every other wrapper means the message isn't an answer.
- **Spacing and case.** No-break spaces, and runs of spaces or tabs, count as one space. The whole message is read in any letter case, so `g8B` is G8b.
- **Forms that arm nothing.** A trailing period, `#<id>`, a reason after an Accept, `Create it` without its period, `Approve:review` with no space, and smart quotes round the whole answer. The recorder tells Claude the forms it accepts.
- **Human check.** Before arming, the guard looks up the prompt's transcript entry by promptId at the first tool call. isHuman is origin.kind human, and clientPlatform in `HUMAN_PLATFORMS` or entrypoint `cli`, and no wrapper once the app context is stripped. Typed text in the desktop app, from the phone over Remote Control, or in an interactive terminal session counts.
- **Not human.** A click on the agentic-midas band arrives with origin.kind plugin, so `Create it.` arms only when the developer types it. A prompt from `claude -p`, a multi-line paste, a slash command, a doc comment, a subagent's prompt and every machine source arm nothing.
- **Repeat prompt_id.** Before deleting the arm, the recorder compares the input's `prompt_id` with the last `prompt_id` it saw in the session, armed or not, kept in `last-<session_id>` in the data folder. A repeat deletes the arm and writes nothing to the ledger or gates.log: no answer, no reason and no `verified` line. So it fails closed. A background notification arriving during a turn reuses the running turn's `prompt_id`, so it ends that turn's arm.

| Message | Records | Arms for this message |
| --- | --- | --- |
| `Accept G<n> <id>`, n from 0 to 13, and `Accept G8b <id>`, `Accept G9b <id>` | accept | That gate's classes, below |
| `Accept G8b PR<n>` | accept | Publishing and reviewers on PR n |
| `Accept G11 PR<n>` | accept | The merge of PR n |
| `Refuse G<n> <target>`, with or without `: <reason>`, with any target an Accept for that gate takes | refuse | Nothing. Without a reason, the next message is recorded as the reason |
| `Skip G<n> <target>: <reason>`, with any target an Accept for that gate takes | skip | Nothing |
| `Pause <id>`, with or without `: <reason>` | pause | Nothing. Without a reason, the next message is recorded as the reason |
| `Take <id>` | take | take on id, unless the ledger has a gate answer for id |
| `Tested <id>` | tested | tested on id, only after the latest take for id, and only if the ledger has no gate answer for id |
| `Approve: comment <id>` | approve | comments on id |
| `Approve: update <id>` | approve | item on id, with any state or column the item class allows |
| `Approve: create item`, or the agentic-midas button text `Create it.` | approve | create |
| `Approve: review PR<n>` | approve | Comments, thread status and the developer's vote on PR n |
| `Approve: reply PR<n>` | approve | Thread replies, thread status, and title and description edits on PR n. No vote |
| `Approve: push <branch>` | approve | The simple push of that branch, if it isn't protected or midas/dev |
| `Approve: pipeline <definition id>` | approve | Runs of that pipeline definition |
| `Approve: edit harness` | approve | Edits to the harness paths below. Never gate state |

- The next-step box offers two buttons: `Accept G<n> <id>` and `Refuse G<n> <id>`. Every other answer is typed.
- `Accept G11 <id>` parses but arms nothing. The recorder tells Claude the `Accept G11 PR<n>` form.
- The agentic-midas button text `Update it.` arms nothing. refine-item's update needs `Accept G1 <id>` or `Approve: update <id>`.
- An accept arms its gate whenever it is sent. The skills keep the stage order; the guard doesn't.

## What each answer arms

| Answer | Classes and targets |
| --- | --- |
| G0 | item on id: assigning it, and moving it to Active. The guard can't see the item's type, so it allows Active on any type. The S0 stage file limits Active to support tickets, the only type that has it |
| G1, G2 | item on id, with no state or column change; comments on id |
| G3, G5, G6, G7, G10 | Nothing. G10 records the teammate's pass |
| G4 | item on id: assigning it and moving it to Implementation |
| G8 | push of a branch with the id as a whole segment; pr create as a draft whose source branch has the id, whose work items include the id and whose target is the trunk or a Release branch; links between id and a PR created in this message |
| G8b with id | pr publish and reviewers on PRs the ledger records for id; item on id: moving it to Approval |
| G8b with PR n | pr publish and reviewers on PR n |
| G9 | deploy; pipeline runs of 429, 504, 522, 515 and 447 |
| G9b | item on id: moving it to Ready for testing; comments on id; testcase for id |
| G11 PR n | merge of PR n, unless its repository is BigChange.Database or can't be named from its id |
| G12 | item on id, with no state or column change; create, for one Change Request in the Midas area, only while `created.item` is empty |
| G13 | item on id; comments on id; create, for one item per message; close on id, under the close rule below. Each further follow-on item needs its own `Approve: create item` |

When the ledger records no PR for the id, G8b works by PR number only (`Accept G8b PR<n>`). The PR's item link then comes from `workItems` at create, under G8.

**Close rule.** G13 closes an item only when its latest human G10 answer is an accept, or a skip with a reason. That answer must come after the item's latest push or deploy event. These are the events:

- a G8 accept for the id;
- an `Approve: push` of a branch with the id as a whole segment, `(^|/)<id>(-|$)`;
- a G9 or G9b accept for the id.

`Approve: pipeline` isn't an event. It isn't bound to an item, and the containers deploy under G9.

## Action classes

| Class | Tools and inputs |
| --- | --- |
| item | `wit_work_item_write` update or update_batch, and `wit_work_item_attachment_link` and `wit_work_item_attachment_upload` with a fileName starting `<id>-`. Every entry and every op must target the id. Patch paths are `/fields/<Ref.Name>`, using reference names (with a dot), or `/rev` with op test only. No field may be set twice. Any `/relations` path is always blocked, because links go through `wit_work_item_link_write`. It never touches Tested By, Testing, Approved, Closing, Done, Closed or Removed. It changes state or column only as the answer names. `wit_work_item_link_write` is allowed between item ids only; links to PRs are G8's |
| comments | `wit_work_item_comment_write` on the target id |
| create | One `wit_work_item_write` create in area BigChange\Finance\Midas, then links on the created id |
| take | Moving the item to Testing |
| tested | Custom.TestedBy, and moving the item to Approved, Closing, Ready for testing or Implementing; comments; attachments named `<id>-` |
| close | State Closed or Removed, or column Done, on the target id |
| testcase | `testplan_test_case_write` create with testsWorkItemId equal to the id, then update_steps on case ids created in the same message |
| pr | `repo_pull_request_write` create, or update setting only isDraft false, title or description; `update_reviewers`; `repo_pull_request_thread_write`. Vote only under `Approve: review PR<n>`. A title or description with "Fix", "Fixes", "Fixed", "Close", "Closes", "Closed", "Resolve", "Resolves" or "Resolved" followed by `#<digits>` is denied |
| merge | `repo_pull_request_write` update with autoComplete true, transitionWorkItems false, mergeStrategy Squash and deleteSourceBranch true, and nothing else besides the ids |
| push | The simple push of a branch that meets the target rule |
| deploy | The simple push of midas/dev |
| pipeline | `pipelines_write` run_pipeline with only action, project, pipelineId and `resources.repositories.self.refName`. Containers must run on refs/heads/midas/dev. previewRun true counts as a read |

Always blocked, whatever the message:

- **Any call from a subagent.** Every outward action whose input carries `agent_id`.
- **Azure DevOps write tools:** `wiki_upsert_page`, `work_capacity_write`, `work_iteration_write`, `repo_create_branch` and `repo_file_write`.
- **Pipeline changes:** `pipelines_write` create_pipeline, rename_pipeline and update_build_stage.
- **Work item changes:** `wit_work_item_write` add_child, any `/relations` patch path, `wit_backlog` reorder, and test suite and test plan writes.
- **PR changes:** abandoning a PR, cancelling auto-complete, and bypassPolicy true.
- **Local downloads:** `wit_work_item_attachment` with savePath and `pipelines_artifact` with destinationPath.
- **The agentic-midas plugin's server:** every write on it.
- **Other routes to Azure DevOps** (spec R50):
  - any shell web request to an Azure DevOps host, GET included;
  - scripts that drive the Azure DevOps MCP server, in any spelling: `@azure-devops/mcp`, `@azure-devops\mcp` or `mcp-server-azuredevops`;
  - `az repos`, `az boards`, `az pipelines` and `az devops`.
- **Publishing and credentials:** package publishing, PublishPlugin, any push from the midas-harness repo, and credential reads.
- **Other sessions and settings:**
  - starting Claude Code;
  - browser navigation to Azure DevOps;
  - Remote Control, permission mode and app setting changes, unless `Approve: edit harness` is armed. A subagent's setting change is denied even then.

Reads are an allowlist of (tool, action) pairs from the [ADO facts](../../research/2026-11-11-harness-facts/ado.json). Any other tool with the Azure DevOps prefix counts as outward, because the user-scope server is unpinned and can gain tools.

## Git rules

**The simple push.** The form is `git -C <absolute repo path> push [-u|--set-upstream] origin <branch>`. An arm lets it through only when all of these hold:

- `<branch>` is a plain local branch name: no `+`, `:`, `refs/`, tag or HEAD, and `git rev-parse --verify refs/heads/<branch>` succeeds.
- `<branch>` isn't protected.
- The target matches:
  - Under G8, the id is a whole segment of the branch name: `(^|/)<id>(-|$)`.
  - Under `Approve: push`, the branch is the one named.
  - For deploy, the branch is midas/dev.
- `git -C <repo> config --get-regexp` finds none of `remote.origin.push`, `remote.origin.pushurl`, `remote.origin.mirror`, `push.recurseSubmodules`, `push.followTags`, `url.*.insteadOf` or `url.*.pushInsteadOf`. It finds no `push.default` other than simple or current. The guard runs this check with `XDG_CONFIG_HOME` and `GIT_CONFIG_*` cleared.
- `git -C <repo> remote get-url --push origin` points to the bigchange organisation, ignoring userinfo. `vs-ssh.visualstudio.com:v3/bigchange` counts as an organisation URL.
- The call has no `agent_id`, isn't run in the background and isn't a Monitor command.

**Push detection.** Every other command containing a push is denied, with a request to restate it in the simple form. A push naming a URL instead of a remote is always a checked push, even in a repo outside BigChange, so it is denied with a request to use the simple form. Detection reuses the prototype in `prototypes/git-classifier`. The build extends it to treat these as code:
- the values of `rebase -x`/`--exec`, `bisect run`, `submodule foreach`, `difftool -x`/`--extcmd`, `grep -O`/`--open-files-in-pager` and `--upload-pack`;
- the `remote-*`, `send-pack` and `http-push` subcommands.

Bash and Monitor are parsed as bash. PowerShell is parsed as PowerShell 5.1. `run_in_terminal` is classified under both shells, using its own `cwd`, and the stricter verdict wins.

**Which repo.** Shell rules take the repo only from `-C <absolute path>`, or from `run_in_terminal`'s own `cwd`. They never trust the hook's `cwd`, because a `cd` inside a command doesn't show in it (build check 6).

**Content changes while pushing.** While push or deploy is armed, commit-class git commands are denied: commit, merge, cherry-pick, rebase, am, revert, `git pull`, and every `git reset`, unstaging included. When nothing is armed, `git pull` and `git reset` are allowed on any branch, a trunk included (spec N9).

**Protected branches.** These are:
- each repo's trunk: WebRelease2, main, and legacy for Sage50-legacy;
- master and develop;
- `release/*`, ignoring case.

A push to a protected branch never passes. A commit on one is denied in repos whose origin is in the bigchange organisation. `*` (several branches) and `?` (unresolvable) count as protected.

**Config writes.** `git config` writes at any scope, and `-c`, `--config-env` and `GIT_CONFIG_*` on a command line, are denied unless `Approve: edit harness` is armed.

**Credentials and publishing.** These are matched on the parsed command, after `-C`, `-c` or `--git-dir` and any path or `.exe`:
- `git credential fill` or `git credential get`;
- `git credential-manager get`, and `git-credential-manager(.exe) get`;
- `npm`, `pnpm` or `yarn` publish, including `yarn npm publish`;
- `nuget push` and `dotnet nuget push`;
- any push in the midas-harness repo, whether `-C`, `--git-dir` or the working directory points there.

## Paths

**File tools.** Write, Edit, NotebookEdit and Artifact are file tools. Artifact's `file_path`, `file_paths`, `files`, `root` and `out_dir` get the Write rules. So publishing a harness file, such as the README, as an Artifact needs `Approve: edit harness`. An Artifact read's `out_dir` must be inside the session scratchpad.

**Always denied.** These are matched in file tool paths, and in shell command text one level into scripts. In shell text they count only as path tokens, never inside `-m` or `--message`:
- the plugin data folder in any path form, plus `ledger.jsonl`, `arm-*.json` and `gates.log`;
- `~/.claude/shell-snapshots/` and `~/.claude/session-env/`;
- `~/.claude/projects/*/*.jsonl` transcripts.

**Harness paths, denied unless `Approve: edit harness` is armed.** In shell text they're denied on write forms only. A subagent's harness edit is denied even under `Approve: edit harness`. The harness paths are:
- the whole midas-harness tree;
- `~/.claude/plugins/` and `~/.claude/skills/`;
- any `.claude/skills/` or `.claude/commands/` folder, and any path containing `.claude-plugin`;
- any `.claude/settings.json` or `.claude/settings.local.json`;
- `~/.claude.json` and `.mcp.json`;
- files under a `.git` folder;
- `~/.gitconfig`, `~/.config/git/` and `$XDG_CONFIG_HOME/git/`;
- the bash and PowerShell profiles;
- the registry key `HKCU\SOFTWARE\Policies\ClaudeCode`, in `HKCU:` and `HKEY_CURRENT_USER` spellings and through `reg.exe`;
- git commands that change the midas-harness working tree, including a branch switch (`git checkout <ref>` or `git switch`). The plugin loads in place, so checking out an older commit could put the shell rows back in shadow mode.

## Browser rules

An Azure DevOps host is `dev.azure.com` or any `*.visualstudio.com` host, documentation hosts such as code.visualstudio.com included.

Always denied:
- `navigate` or `preview_start` to an Azure DevOps host;
- `browser_batch` with such a navigate inside it;
- `javascript_tool` code naming an Azure DevOps host.

What is left is spec N7: clicks, form input and scripts on an Azure DevOps tab the developer opened. Redirects, `data:` pages, script-built URLs and browser back and forward are listed under known escapes.

## Session, schedule and app-setting rules

Denied:
- SendMessage, session start, hand-off and `move_to_cloud`, `send_message`, CronCreate, RemoteTrigger and scheduled-task creates or updates, when their text has a line matching any answer;
- `set_remote_control`, `set_session_permission_mode` and `set_setting`, unless `Approve: edit harness` is armed, and always from a subagent;
- PublishPlugin, whatever the message.

The morning list is scheduled only with the Code-tab scheduler (`mcp__scheduled-tasks`), whose runs load the hooks (build check 11). A claude.ai app scheduled task is never used: it runs away from this PC and no hook fires.

## Data model

- **`${CLAUDE_PLUGIN_DATA}/arm-<session_id>.json`:** `{session_id, prompt_id, answer, gate, target, classes, origin, created}`.
  - On every prompt, the recorder first compares the input's `prompt_id` with the last one it saw in the session (`last-<session_id>`), then deletes the arm. On a repeat `prompt_id` it stops there: no new arm, and nothing in the ledger or gates.log. Otherwise it writes the new arm.
  - `origin` is the answer's origin when the arm was written: human, other or pending, as in the ledger.
  - `created` holds the ids made by this message's own create calls, by kind: `pr`, `item` and `testcase`.
  - The guard checks liveness on every outward decision, with no cache. The arm is live only when its `session_id` matches, its `prompt_id` matches, and the human entry with that promptId passes isHuman.
  - The `prompt_id` to match is the PreToolUse input's. If the input has none, the guard reads `transcript_path` and takes the latest entry of type `user` that isn't a tool result, skipping entries of other types (assistant, attachment, system). The arm is then live only when that entry's promptId equals `arm.prompt_id`, and the human entry with that promptId passes isHuman.
  - A meta or attachment-carrying `user` entry after the prompt still counts as the latest. One with another promptId, or none, ends the arm. A slash command's meta expansion carries the prompt's own promptId, so it doesn't.
  - Any mismatch or read error means nothing is armed.
- **`${CLAUDE_PLUGIN_DATA}/ledger.jsonl`:** one line per answer or created id, `{prompt_id, kind, value, origin}`, deduplicated on the whole line. Only the hooks write it. It is the gate record.
  - **Origin.** Each line carries origin human, other or pending, by the method build checks 3 and 4 allow. A prompt's entry is absent at UserPromptSubmit, so the recorder writes other when the prompt text alone shows a machine source, such as a wrapper, and pending when it can't yet tell. At the next prompt, when the previous arm's origin is pending and its prompt's entry passes isHuman, the recorder appends a `verified` line, `{prompt_id, kind: 'verified', value: prompt_id, origin: 'human'}`, with the earlier prompt's id in both places. It makes that prompt's pending lines human.
  - **Created lines.** Kind `created`, with value `pr <n> <id>`, `item <n>` or `testcase <n> <id>`. They're always human, because only an armed human message can create.
  - These read it: the close rule and the take and tested checks, using human lines only; the own-item test (any gate answer for the id, whatever its origin); and G8b's PR lookup.
- **`work\<id>\gates.log`:** a readable copy of the item's ledger lines. It is never read for decisions.
- **`work\<id>\task.md`:** Claude writes it, and it is the item's record. Memory notes only point to it.
  - Front matter: `id`, `type`, `title`, `track`, `repos`, `services`, `stage`, `prs` (each with its own repo, branch, worktree and stage), `midas_dev_merge`, `refusals` and `updated`.
  - Body: one short entry per stage.

## Build checks

Each of these runs before anything relies on the guard. Results are recorded in this file.

1. A hook deny stops a call in default, acceptEdits, auto and bypass modes (spec R31).
2. `prompt_id` is in PreToolUse input and matches the turn's UserPromptSubmit. Task notifications, cron and /loop fires, Monitor events and messages from other sessions each start with a new `prompt_id`. Subagent calls carry the parent's `prompt_id` and an `agent_id`.
3. Which inputs reach UserPromptSubmit, and with what text, origin and clientPlatform:
   - typed text;
   - next-step buttons;
   - agentic-midas buttons;
   - SendMessage;
   - cron, /loop and scheduled tasks;
   - `claude -p`;
   - Remote Control from claude.ai/code;
   - prompts relayed from Slack or Teams;
   - artifact and doc comments;
   - messages queued during a turn.

   This answered spec Q1 (row 3 of the results).
4. The prompt field holds the raw `/midas-sdlc:task 362525` text.
5. Exec-form `node` resolves on this machine.
6. The hook's `cwd` follows the PowerShell tool's location and Bash `cd`.
7. Tool calls from plugin agents and general-purpose subagents carry `agent_id`.
8. The local marketplace loads in place, and `/plugin` and `/reload-plugins` work in the desktop app. Also confirm the data folder path, and which copy of the hooks runs.
9. Which instruction files load when working on a worktree path: the workspace root's, the main checkout's and the worktree's. Whether auto-memory still loads.
10. Whether `pipelines_build_log` list shows a waiting pipeline approval (spec Q3).
11. A desktop scheduled task can call `mcp__azure-devops__` reads, and agentic-midas's ask doesn't stall it.
12. PostToolUse sees the ids returned by PR, work item and test case creates.
13. The WIQL macro `@RecentMentions` works.
14. Whether `HKCU\SOFTWARE\Policies\ClaudeCode` is read on this machine.
15. Whether commit-mention work item resolution is on in the Midas repos.
16. BigChange.Database's repository GUID, so G11 can refuse it.

### Results

| # | Result | Evidence | Date | Consequence |
|---|--------|----------|------|-------------|
| 1 | pass | 12 of 12 calls denied with the probe's deny-marker reason: Bash, PowerShell and `mcp__azure-devops__search_wiki`, each in default, acceptEdits, auto and bypassPermissions (the probe logged each `permission_mode`). No permission prompt appeared. `search_wiki` was denied although agentic-midas allows it. | 2026-11-12 | The mechanism half of T60 and the bypass real-world scenario hold: a hook deny beats an allow in all four modes, bypass included. |
| 2 | pass; mid-turn deliveries are handled by the repeat rule (stop-1, built in task 10) | UserPromptSubmit and PreToolUse inputs both carry `prompt_id`, and every PreToolUse carried its turn's UserPromptSubmit value. Each source that arrived while Claude was idle started a new `prompt_id`: background command and Monitor notifications, a CronCreate fire, cross-session messages both ways, a subagent hand-back, the agentic-midas band and a Code-tab scheduled run. Calls from a plugin agent and a general-purpose subagent carried the parent turn's `prompt_id` plus `agent_id`. But three task notifications (two subagent completions and a hook notice) that arrived while a typed turn was still running each fired UserPromptSubmit with that typed turn's `prompt_id`. The transcript holds them as `attachment` entries (`queued_command`) with no promptId, so the latest `user` entry stays the human prompt. Two attachments carry origin task-notification (producer session-task). The hook notice's attachment has no origin and is marked isMeta. Two typed messages sent 7 s apart each got their own `prompt_id`. No typed message was seen reusing one, but whether the second was truly queued isn't confirmed. | 2026-11-12, 2026-11-13 | A non-human source reused a human turn's `prompt_id`. A lookup by promptId finds the human entry, so isHuman can't reject a mid-turn delivery. Decided: any repeat UserPromptSubmit on a `prompt_id` disarms, arms nothing and writes nothing, so it fails closed (see [Answers](#answers)). The transcript fallback stays a fallback, because PreToolUse has `prompt_id`. |
| 3 | pass | `### Prompt sources` below records each source's text, origin and platform. The `/loop` fire wasn't captured, but it uses the CronCreate mechanism, which was. A next-step button click arrives exactly like typed text: the exact label, origin.kind human, clientPlatform desktop_app. An agentic-midas band click arrives as `Create it.` with origin.kind plugin and no clientPlatform. A Claude Doc comment arrives as human and desktop_app, but its text starts with the line `[Artifact comment sent to Claude]` and quotes the comment in a BEGIN/END ARTIFACT COMMENT block, and its entry adds `queueSkipAttachments`. A claude.ai app scheduled task ran away from this PC and fired no hook. Prompts relayed from Slack or Teams couldn't be tested: no relay is set up. | 2026-11-12, 2026-11-13 | Spec Q1: next-step button clicks count as the developer's own answers. A band click isn't human, so `Create it.` arms only when typed, and isHuman stays strict. isHuman and parseAnswer reject the comment header, so a comment that reads like an answer arms nothing: not a STOP. Slack and Teams relays arm nothing and stay a known escape until seen. |
| 4 | recorded | The UserPromptSubmit `prompt` held the raw `/midas-probe:probe-skill 999999000`, with no wrapper and not the skill's expanded text. The transcript stores it differently, as a human entry (origin.kind human, desktop_app, no `permissionMode` or `promptSource`) whose content is `<command-message>midas-probe:probe-skill</command-message>`, newline, `<command-name>/midas-probe:probe-skill</command-name>`, newline, `<command-args>999999000</command-args>`. An isMeta expansion entry follows, with `turnCompanion` true, the same promptId and no origin. `/loop 1m PROBE loop` was stored the same way. | 2026-11-13 | The recorder sees `/midas-sdlc:task <id>` as typed text, which matches no answer. Anything reading the transcript sees the `<command-message>` form, never the raw text. In a slash-command turn, the latest `user` entry at PreToolUse is the meta expansion, not the human prompt. It carries the same promptId, so it doesn't end the arm (see [Data model](#data-model)). |
| 5 | pass | UserPromptSubmit logged one `exec` line (`latency_ms` 32) and one `shell` line (`latency_ms` 31) with the same `prompt_id`. The turn was not held up. PreToolUse lines also carry `prompt_id`. | 2026-11-12 | Exec-form `node` rows are used as written; no shell-form fallback is needed. |
| 6 | pass with caveat | A PowerShell `Set-Location` in its own call moved the logged `cwd` of every later call of every tool, and the session's working directory with it. A Bash `cd` in its own call did the same for later calls, but a call in the same parallel batch still logged the old `cwd`. A `cd … &&` inside one Bash command never shows: the hook sees the `cwd` from before the command. `run_in_terminal` carries its own `cwd` in `tool_input`; the hook's `cwd` is the session's, not the tab's. | 2026-11-13 | Shell rules trust only `-C <absolute path>`, and `run_in_terminal`'s own `cwd`, never the hook's `cwd`. |
| 7 | pass | Bash PreToolUse calls from a `midas-probe:probe-agent` subagent and a `general-purpose` subagent both carried `agent_id` and `agent_type` (the input keys add both), the parent's `session_id` and the parent turn's `prompt_id`. No UserPromptSubmit fired for either agent's prompt. | 2026-11-13 | "Any call from a subagent" is detected by `agent_id` in the input. Spec R28 holds for subagents. |
| 8 | pass (in place) | `installed_plugins.json` lists installPath `C:\Users\dev\.claude\plugins\cache\midas-harness\midas-probe\0.0.1` (a cache copy exists, gitCommitSha 7a22de1), but the logged `env.root` and script are the repo path `C:\dev\Projects\BigChange\midas-harness\plugins\midas-probe\hooks\probe.js`. `env.data` is `C:\Users\dev\.claude\plugins\data\midas-probe-midas-harness`. `BUILD` changed from `b1` to `b2` in the repo's `probe.js`, and the next hook call logged `b2` with no reload. `hooks.json` changes took effect only after `/reload-plugins` (an added row did nothing until reload). `/plugin` commands ran through the CLI at user scope; `/reload-plugins` works in the desktop app and "isn't available over a remote connection". | 2026-11-12 | Code changes are live on save: no version bump and no `/plugin update`. Every `lib/` or hooks change after task 16 is made in a linked worktree and fast-forwarded into main only when the full suite is green. `hooks.json` changes need `/reload-plugins`, which only works in the desktop app, not over Remote Control. |
| 9 | recorded, with a gap | From a session at the workspace root, a Read of a JobFinance worktree's CLAUDE.md (`.claude/worktrees/<id>`) fired InstructionsLoaded (load_reason nested_traversal, memory_type Project) for the main checkout's CLAUDE.md and its five `.claude/rules/common` files, not the worktree's own. Worktrees sit inside the main checkout, so a session outside them gets the main checkout's rules, which may differ from the worktree branch's. A new session opened for the worktree logged its `cwd` as the main checkout, not the worktree, and loaded the same files at session start. `/context` fired no UserPromptSubmit. Not observed: whether a desktop session can start inside a worktree, and whether auto-memory loads there. | 2026-11-13 | The worktree's own files don't load, so skills and agent briefs tell agents to read the worktree's own CLAUDE.md and `.claude/rules`, and repeat the always-on rules. |
| 10 | fail (listing shows no step names) | With a JobFinance run (definition 1438) in progress, `pipelines_build_log` list returned 82 entries, each only an id, a line count, timestamps and the type `Container`. None carries a step name, so a waiting ManualValidation step can't be told apart. Reading a log's content isn't among the calls this check allows. | 2026-11-13 | Spec Q3 is (b): timed reminders only. The morning list and watch don't claim to see a run waiting at an approval (R48). |
| 11 | pass | A one-off desktop scheduled task (Code tab, bypass mode) loaded `core_list_projects` through ToolSearch and returned a count of 2 projects. The run had no human at the PC and nothing stalled it. The task was then deleted. | 2026-11-13 | The morning list runs as a weekday desktop scheduled task (T82), using the same permission mode. |
| 12 | partly, by design | A `wit_work_item` get on a real item fired PostToolUse with `tool_response` as an array of content blocks, `[{type: 'text', text}]`; the probe found no id outside the text. The source of `@azure-devops/mcp` 2.11.0 shows each create returning `content[0].text` as the created object's JSON: `repositories.js:741` (PR create, keeping `pullRequestId`), `work-items.js:686` (work item create, `id`) and `test-plans.js:388` (test case create, `id`). Failures return `isError: true` with a plain text message. No create was run, under the builder rule. Whether the text carries an untrusted-content wrapper wasn't logged. | 2026-11-13 | The recorder reads created ids with `JSON.parse(tool_response[0].text)`: `.pullRequestId` for a PR, `.id` for an item or test case. It records nothing on `isError`, or when the parse or the id fails. Then G8b works by PR number only, and the PR's item link comes from `workItems` at create (see [What each answer arms](#what-each-answer-arms)). The developer's first real create confirms the live shape. |
| 13 | pass | `wit_query` wiql with `[System.Id] IN (@RecentMentions)`, top 50, returned without error and listed four item ids. | 2026-11-13 | R44 keeps mentions. |
| 14 | pass: key absent, bundle reads it | `reg query HKCU\SOFTWARE\Policies\ClaudeCode` found no key. The 2.1.321 `claude.exe` bundle holds the strings `SOFTWARE\Policies\ClaudeCode` and `HKCU\SOFTWARE\Policies\ClaudeCode`, and a message that names the registry key. | 2026-11-13 | The key doesn't exist on this machine, but Claude Code reads it, so the deny rule on the key stays. |
| 15 | on, in all five repos | In BigChange, BigChange.JobFinance, BigChange.MFE.Suite, BigChange.Database and BigChange.Xero, an item named in a merged commit's message has a "Fixed in Commit" ArtifactLink to that commit's hash. Items read: 362303, 362525, 362377, 360891, 359687. For Xero, the merged commit named Feature 359687, not a story, and the link landed on that Feature. Linking doesn't depend on the item type, so this still counts as on. | 2026-11-13 | Commit-mention linking is on, so the G7 other-item check stays mandatory. |
| 16 | pass | `repo_repository` found BigChange.Database: id e3274a22-f709-45af-a46f-aa7e21008b18, default branch main. Every repo id and trunk is in `### Constants`. | 2026-11-13 | G11 can deny any GUID-form repositoryId not in `REPO_IDS`. |
| onFailure block on a crash | pass | A Bash row whose hook crashed: "[command hook 2]: failed; blocking because onFailure is "block"". No echo output. PowerShell kept working. Row removed and reloaded; `git diff --exit-code -- plugins/midas-probe/hooks/hooks.json` exits 0. | 2026-11-12 | R32 holds for a crash: a failing PreToolUse hook with onFailure "block" stops the call. |
| onFailure block on an MCP tool | pass | The same row on `mcp__azure-devops__core_list_projects`: the same blocking message, call not run. Row removed and reloaded. | 2026-11-12 | R32 holds for MCP tools as well as shell tools. |
| onFailure block on a timeout | pass | A Bash hook with a 2 s timeout: "[command hook]: timed out; blocking because onFailure is "block"". Row removed and reloaded; `hooks.json` unchanged. | 2026-11-12 | R32 holds for a timeout: a hook that overruns blocks the call. |
| transcript lag | pass | At every UserPromptSubmit that started a turn, the prompt's own transcript entry was absent. At the turn's first PreToolUse it was present, for every source that made a tool call. | 2026-11-12, 2026-11-13 | The recorder can't read origin at UserPromptSubmit. Arming waits for the first PreToolUse, which looks the entry up by promptId. |
| uninstall data behaviour | data deleted | The developer ran `plugin uninstall midas-probe@midas-harness` through the CLI, without `--keep-data`, then reloaded. The data folder `C:/Users/dev/.claude/plugins/data/midas-probe-midas-harness` was deleted, `probe.jsonl` with it. The plugin's `installed_plugins.json` entry and its `enabledPlugins` entry in `settings.json` were removed. The cache copy `C:/Users/dev/.claude/plugins/cache/midas-harness/midas-probe/0.0.1` was left behind. | 2026-11-13 | Uninstalling deletes a plugin's data folder, so uninstalling midas-sdlc would delete the gate record. The README's Recovery section says so, and midas-sdlc is only ever disabled. |

### Constants

Read from Azure DevOps and the local clones on 13 Nov 2026 (build checks 10, 13, 14, 15 and 16). Tasks 8, 13, 15 and 21 copy these. Keys are Azure DevOps repository names, never folder names.

**Repositories**

`DATABASE_REPO_ID` = `e3274a22-f709-45af-a46f-aa7e21008b18`

| Repository name | `REPO_IDS` | `TRUNKS` |
| --- | --- | --- |
| BigChange | 1fc9a900-b3cf-4d25-a849-b69c0879a860 | WebRelease2 |
| BigChange.JobFinance | 37b53924-b4e3-47cd-9244-76a39a19b259 | main |
| BigChange.Xero | bd877eb4-5e6a-4bab-b57c-7703558a0d9d | main |
| BigChange.MFE.Suite | 781963ca-4b97-499b-bbef-3e3d9b126680 | main |
| BigChange.ExportCsv | 48c808b7-98dc-4150-96fd-3c965117d1bc | main |
| BigChange.BatchDataProcess | 6441bcfa-58c2-4171-b4fc-1fb74159fa2e | main |
| BigChange.BO.RestApi | a03de750-a0e5-4b54-bfb9-6ba34b1a2167 | main |
| BigChange.Database | e3274a22-f709-45af-a46f-aa7e21008b18 | main |
| BigChange.Sage50 | 434e7aa2-2eb8-4d70-af8f-5bdfef37cda7 | legacy |

Sage50 repo name: BigChange.Sage50. The BigChange.Sage50-legacy folder and the BigChange.Sage50 folder both have origin `_git/BigChange.Sage50`. The legacy folder's clone tracks only `origin/legacy`. Azure DevOps' own default branch for the repository is `main`, so `legacy` is the working trunk the brief named, not the default.

Two naming differences from the brief: the Azure DevOps name is `BigChange.ExportCsv` (the local folder and its origin URL say `ExportCSV`, and `repo_repository` get by the `CSV` spelling returned not found), and the repository list call returned only 200 of the project's repositories, so the ids above come from `get` calls on each name.

**Item moves** (`COLUMN_FIELDS` below; state and column names read from `get_type` for Bug, User Story, Enabler and Platform Support, and from the revisions of #362302)

| Answer | Assign | States | Columns |
| --- | --- | --- | --- |
| G0 | yes | Active (any type; only Platform Support has it) | none |
| G4 | yes | Implementation | Implementing |
| G8b | no | Approval | Reviewing |
| G9b | no | Approval | Ready for testing |
| take | no | Approval (no change) | Testing |
| tested | no | Approved (Bug only), Approval, Implementation | Closing, Ready for testing, Implementing |

Testing is a column only, not a state: #362302's revisions go Approval/Reviewing, Approval/Ready for testing, then Approval/Testing. Take's states stay Approval, and task 8's MOVES needs no Testing state. Tested By was set while the item was in the Testing column, before Approved/Closing and Closed/Done.

State lists: Bug has New, In Query, Approved, Elaboration, Ready, Refinement, Implementation, Approval, Merge, Closed, Removed. User Story and Enabler have New, Refinement, Next Up, Elaboration, Ready, Implementation, Approval, Merge, Closed, Removed. Platform Support has New, Active, Closed.

**Types with an Active state:** Platform Support only. Bug, User Story and Enabler have none, so G0's Active move only applies to a support ticket.

**Forbidden on an own item:** states Approved, Closed, Removed; columns Testing, Closing, Done; the field Tested By (`Custom.TestedBy`). The state Testing doesn't exist.

Checked against the closed items #362302 (Bug), #362730 (Bug), #362613 (Platform Support) and the developer's #361682 (Bug, Approval, Ready for testing).

**Field names**

`COLUMN_FIELDS`:
- `System.BoardColumn`, `System.BoardColumnDone`
- `WEF_36778208447642C48B0A0F72C104A5C5_Kanban.Column`, `.Column.Done` and `_Kanban.Lane` (the Midas board)
- `WEF_3057C7889BA14D699C0145FC63698233_Kanban.Column`, `.Column.Done`
- `WEF_238344A83E10404F9482A4EA1FE089FE_Kanban.Column`, `.Column.Done`
- `WEF_7E5ADB2892434098BFD64641BF240A5A_Kanban.Column`, `.Column.Done` (a fourth board, seen on Bug #362302 only; not in the brief's list)

`TESTED_BY_FIELD` = `Custom.TestedBy`. Odyssey items carry other board columns (for example `WEF_8CE0FBEA634945B7AF949A8568A7694F_Kanban.Column`); those aren't Midas items and aren't in `COLUMN_FIELDS`.

**Pipelines** (definition id, name)

| Use | Id | Name |
| --- | --- | --- |
| `G9_PIPELINES` | 429 | ClientSite - Container |
| `G9_PIPELINES` | 504 | WebServices - Container |
| `G9_PIPELINES` | 522 | Bookings - Container |
| `G9_PIPELINES` | 515 | BigServices - Container |
| `G9_PIPELINES` | 447 | ScheduledTasks - Container |
| Morning list | 1438 | BigChange.JobFinance |
| Morning list | 1274 | BigChange.Xero |
| Morning list | 770 | BigChange.MFE.Suite |
| Morning list | 1290 | BigChange.BO.RestApi |
| Packages | 1317 | BigChange.Packages |

`G9_PIPELINES = [429, 504, 522, 515, 447]`. The morning list's definition ids are 1438, 1274, 770 and 1290.

### Prompt sources

Recorded with the probe on 12 and 13 Nov 2026, in default, acceptEdits, auto and bypass modes. UserPromptSubmit input has no origin or clientPlatform, so both come from the prompt's transcript entry. "Entry" means that entry, looked up by promptId. Ids are fake.

| Source | UPS fired | Text received (fake ids) | Wrapper | New prompt_id | origin.kind | clientPlatform | Entry at UPS | Entry at first PreToolUse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Typed text, desktop app | yes | `PROBE queued one` | none | yes | human | desktop_app | absent | present |
| Typed text, Remote Control from the phone | yes | `PROBE typed` | none | yes | human | ios | absent | present |
| Two quick typed messages | yes, each | `PROBE queued one`, then `PROBE queued two` 7 s later | none | yes, each | human | desktop_app | absent | present |
| Next-step button click, Accept | yes | `Accept G3 999999000`, the exact label | none | yes | human | desktop_app | absent | present |
| Next-step button click, Refuse | yes | `Refuse G3 999999000`, the exact label | none | yes | human | desktop_app | absent | present |
| Next-step buttons over Remote Control | — | Not shown on the phone | — | — | — | — | — | — |
| One-line paste | yes | `Accept G3 999999000` | none | yes | human | desktop_app | absent | present |
| 30-line paste ending in an answer | yes | Two newlines, `<pasted_content id="…">`, 29 lines, `Accept G3 999999000`, then `</pasted_content id="…">` with the same id | `<pasted_content id="…">` | yes | human | desktop_app | absent | present |
| Typed while a Claude Doc is open in the side pane | yes | An `<artifact-view-context artifact="…">` JSON block and a note, then the typed text | `<artifact-view-context …>` | yes | human | desktop_app | absent | present |
| Claude Doc comment sent to Claude | yes | `[Artifact comment sent to Claude]`, `Artifact: …`, `Comment thread: …`, then the comment between `=== BEGIN ARTIFACT COMMENT <token> ===` and `=== END … ===`, each line starting `> ` (`> ＠Claude PROBE comment Accept G3 999999000`, with a full-width ＠) | `[Artifact comment sent to Claude]` | yes | human | desktop_app | absent | present, with the extra key `queueSkipAttachments` |
| Skill slash command `/midas-probe:probe-skill 999999000` | yes | The raw command. The transcript stores it as `<command-message>` + `<command-name>` + `<command-args>` | none in the prompt | yes | human (read from the transcript: the probe logged no entry, as there was no tool call) | desktop_app | absent | — (no tool call) |
| `/loop 1m PROBE loop`, typed | yes | The raw command, stored in the transcript like the skill command | none in the prompt | yes | human on the raw entry. The latest `user` entry at PreToolUse is the isMeta expansion, with `turnCompanion`, the same promptId and no origin | desktop_app on the raw entry | absent | the meta expansion is present |
| `/loop` fire | — | Not captured: the job was cancelled before its first fire | — | — | — | — | — | — |
| Background command completion | yes | `<task-notification>…` | `<task-notification>` | yes | task-notification (producer session-task) | none | absent | present |
| Monitor event | yes | `<task-notification>…<event>PROBE monitor</event>…` | `<task-notification>` | yes | task-notification (producer session-task) | none | absent | present |
| Task notification arriving while a turn runs (two subagent completions, a hook notice) | yes, each | `<task-notification>…` | `<task-notification>` | **no: the running turn's** | none of its own. The transcript adds an `attachment` entry (`queued_command`) with no promptId: origin task-notification on the two completions, no origin (isMeta) on the hook notice | none | the running turn's human entry is present | the running turn's entries |
| Subagent hand-back after the turn ended | yes | `<agent-message from="…">` and the report | `<agent-message from="…">` | yes | peer (`handback` true, `name` general-purpose), isMeta true | none | absent | present |
| CronCreate one-shot fire | yes | `PROBE cron`, plain, like typed text | none | yes | no origin key. The entry has isMeta true, `wakeupSource` and turnOrigin scheduled | none | absent | present |
| Code-tab scheduled task, in a new session | yes | `<scheduled-task name="…" file="…">` and the task's prompt | `<scheduled-task …>` | yes | task-notification (subkind scheduled-trigger, fireReason scheduled) | desktop_app | absent | present, with `queueSkipAttachments` |
| claude.ai app scheduled task, "require this computer" on | no | No hook line: the run happened away from this PC | — | — | — | — | — | — |
| agentic-midas band, Create | yes | `Create it.` | none | yes | plugin (name agentic-midas, asUser true) | none | absent | present |
| agentic-midas band, second click after a draft with id 999999000 | yes | `Create it.`, not `Update it.` | none | yes | plugin (name agentic-midas, asUser true) | none | absent | present |
| agentic-midas band, Cancel | no | Nothing sent | — | — | — | — | — | — |
| Message from session B to session A | yes | `<cross-session-message from="local_…" from-name="…">`, `PROBE session-msg Accept G3 999999000`, then the closing tag | `<cross-session-message …>` | yes | peer (hostInjected true, fromMode bypass), isMeta true | none | absent | present |
| SendMessage from session A to session B | yes, in B | The same wrapper, with an artifact-content notice appended to the body | `<cross-session-message …>` | yes | peer (hostInjected true, fromMode bypass), isMeta true | none | absent | present |
| A forked session's first prompt | yes | Two text blocks: a `<system-reminder>` saying the session was forked, then the typed text | `<system-reminder>` | yes | human (read from its transcript) | desktop_app | absent | — (no tool call) |
| `claude -p "PROBE claude-p"` in the developer's PowerShell | yes | `PROBE claude-p` | none | yes | no origin key: entrypoint sdk-cli, promptSource sdk, turnOrigin sdk (read from its transcript) | none | — | — (no tool call) |
| Interactive terminal `claude`, typed | yes | `PROBE terminal` | none | yes | human: entrypoint cli, promptSource typed, turnOrigin human | none: no clientPlatform key | absent | present |
| Prompts relayed from Slack or Teams | — | Untestable: no relay is set up | — | — | — | — | — | — |

### Facts

Recorded from the probe log and the session transcripts, 12 and 13 Nov 2026, Claude Code 2.1.321. Tasks 7 to 16 build on these.

**Who counts as human**

- `HUMAN_PLATFORMS` is `desktop_app` (the desktop app) and `ios` (Remote Control from the phone).
- The interactive terminal (`claude` in a shell) marks a typed prompt origin.kind human with no `clientPlatform` key: entrypoint `cli`, promptSource `typed`, turnOrigin `human`. `HUMAN_PLATFORMS` can't hold it, so isHuman also accepts entrypoint `cli` (see [Answers](#answers)).
- `claude -p` has no origin key: entrypoint `sdk-cli`, promptSource `sdk`, turnOrigin `sdk`. It is never human.
- A Code-tab scheduled task (`mcp__scheduled-tasks`) runs in a new session on this PC, and the plugin's hooks fire. Its prompt is origin.kind task-notification, subkind scheduled-trigger, but clientPlatform `desktop_app`. So isHuman tests origin.kind, never the platform alone.
- A claude.ai app scheduled task runs away from this PC, even with "require this computer" on, and never reaches its hooks.
- origin.kind with turnOrigin `human` separates human turns from every machine source seen. A human turn's text can still carry a wrapper, listed below.

**Fields per source** (transcript `user` entries; values, not content)

| Source | origin | clientPlatform | entrypoint | promptSource | turnOrigin | isMeta |
| --- | --- | --- | --- | --- | --- | --- |
| Typed, desktop; button click; one-line or 30-line paste; typed with a doc open; doc comment; fork's first prompt | `{kind: 'human'}` | desktop_app | claude-desktop | sdk | human | — |
| Typed, Remote Control | `{kind: 'human'}` | ios | claude-desktop | sdk | human | — |
| Typed slash command (raw entry) | `{kind: 'human'}` | desktop_app | claude-desktop | none | human | — |
| Slash command expansion | none | none | claude-desktop | none | none | true |
| agentic-midas band | `{kind: 'plugin', name: 'agentic-midas', asUser: true}` | none | claude-desktop | system | system | — |
| Background command or Monitor notification | `{kind: 'task-notification', producer: 'session-task', runId}` | none | claude-desktop | system | task_notification | — |
| CronCreate fire | none | none | claude-desktop | system | scheduled | true |
| Code-tab scheduled task | `{kind: 'task-notification', subkind: 'scheduled-trigger', fireReason: 'scheduled'}` | desktop_app | claude-desktop | system | scheduled | — |
| Cross-session message | `{kind: 'peer', from, name, body, hostInjected: true, fromMode}` | none | claude-desktop | system | peer | true |
| Subagent hand-back | `{kind: 'peer', from, senderTaskId, name, body, handback: true, handbackReportText}` | none | claude-desktop | system | peer | true |
| `claude -p` | none | none | sdk-cli | sdk | sdk | — |
| Interactive terminal | `{kind: 'human'}` | none | cli | typed | human | — |

**Transcript entries**

- A typed desktop prompt's entry has these keys: parentUuid, isSidechain, promptId, type, message, uuid, timestamp, permissionMode, origin, promptSource, turnOrigin, turnPosition, clientPlatform, turnAttributionKey, userType, entrypoint, cwd, sessionId, version, gitBranch, slug.
  - `message` is `{role: 'user', content}`. content is a string, or text blocks for a fork's first prompt.
  - `turnPosition` is `{promptIndex, turnIndex}`.
  - Remote Control prompts, cron fires and peer messages add `queueSkipSlashCommands`. Doc comments, notifications, cron fires, peer messages and scheduled runs add `queueSkipAttachments`. A button click has the same keys as typing.
  - Machine sources drop `clientPlatform` and `turnAttributionKey`, except scheduled runs, which keep both. CronCreate fires and peer messages add `isMeta`, and cron adds `wakeupSource`.
  - New sessions from the terminal, `claude -p` and the scheduler have no `slug`.
- A tool result is a `user` entry whose content is `tool_result` blocks, with the turn's promptId and no origin. It adds `toolUseResult`, `sourceToolAssistantUUID` and `permissionDecision`, plus `sandboxed` for Bash.
- Assistant entries carry no promptId.
- A notification delivered during a turn is an `attachment` entry (`attachment.type` `queued_command`) with no promptId. A task notification's attachment carries `attachment.origin`; the hook notice's had none and was marked `attachment.isMeta`.
- A typed slash command's entry stores `<command-message><name></command-message>`, `<command-name>/<name></command-name>` and `<command-args><args></command-args>`, one per line, not the raw text that UserPromptSubmit received. An isMeta expansion entry with `turnCompanion` true and the same promptId follows it. Built-in local commands such as `/reload-plugins` put `<command-name>` first, have no origin and fire no UserPromptSubmit.
- After a compaction, the latest `user` entry with a turn's promptId can be a compact summary (`isCompactSummary`, `isVisibleInTranscriptOnly`, `summarizedTurnPromptUuids`) with no origin. This was seen once. A promptId lookup must find the human entry or fail closed.
- Entry timing: a turn's prompt entry is absent at its UserPromptSubmit and present at its first PreToolUse.

**Wrappers on prompt text.** All are at the very start of the prompt, except `<pasted_content>`.

- `<pasted_content id="…">` … `</pasted_content id="…">`, after two newlines, for a multi-line paste. A one-line paste has no wrapper and counts as typed.
- `[Artifact comment sent to Claude]` as the first line, then `Artifact:`, `Comment thread:` and a `=== BEGIN ARTIFACT COMMENT <token> ===` / `=== END … ===` block quoting the comment with `> `.
- `<artifact-view-context artifact="…">`, prepended to a typed message while an artifact or Claude Doc is open in the side pane. The message stays human and desktop_app, and the recorder strips this block (see [Answers](#answers)).
- `<cross-session-message from="…" from-name="…">` for messages between sessions.
- `<agent-message from="…">` for a subagent's hand-back.
- `<task-notification>` for background commands, Monitor events and subagent completions.
- `<scheduled-task name="…" file="…">` for Code-tab scheduled runs.
- `<system-reminder>` as the first text block of a forked session's first prompt.
- `<command-message>…</command-message>`, `<command-name>/…</command-name>`, `<command-args>…</command-args>` in the transcript entry of a typed slash command. UserPromptSubmit gets the raw `/…` text instead.

**prompt_id per source**

- Every source arriving while Claude is idle gets a new `prompt_id`: typed text, clicks, pastes, notifications, cron fires, peer messages, band clicks and scheduled runs. Each of two quick messages gets its own.
- A notification arriving during a turn fires UserPromptSubmit with the running turn's `prompt_id` (row 2). No typed message was seen reusing a `prompt_id`.
- Subagent calls carry the parent turn's `prompt_id`. No UserPromptSubmit fires for an agent's prompt.

**Hook inputs**

- UserPromptSubmit: session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name, prompt, session_title. No origin or clientPlatform. The first prompt of each of the five new sessions logged had no `session_title` (a Code-tab scheduled run, two `claude -p` runs, the terminal and session B). Their later prompts had one, and so did a forked session's first prompt. `claude -p` has neither `scratchpad_dir` nor `session_title`.
- PreToolUse: session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id.
  - MCP tools add `mcp_server`, as `{name, source}`: `{name: 'azure-devops', source: 'user'}` for server 1 and `{name: 'terminal', source: 'sdk'}` for `run_in_terminal`.
  - Subagent calls add `agent_id` and `agent_type`, after `permission_mode`.
- PostToolUse: session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_response, tool_use_id, duration_ms, mcp_server.
- `scratchpad_dir` is in every hook input from desktop-app and terminal sessions, subagent calls included. It's missing only from `claude -p`.
- `tool_input` keys seen: Bash and PowerShell `{command, description}`; `run_in_terminal` `{command, cwd, title}`.

**The MCP wrapper and create ids**

- An MCP tool's `tool_response` in PostToolUse is the server's content array, `[{type: 'text', text: <string>}]`. The ids sit inside the JSON text.
- Created ids:
  - PR create (`repo_pull_request_write`): `JSON.parse(tool_response[0].text).pullRequestId`.
  - Work item create (`wit_work_item_write`) and test case create (`testplan_test_case_write`): `JSON.parse(tool_response[0].text).id`.
- A failed create returns `isError: true` with a plain text message. How a failure reaches PostToolUse wasn't observed. The fixture `post-create-error.json` models it as the server's result object, `{content, isError}`.

**Session tools** (loaded, not called; both are in the session row of [Hooks](#hooks))

- `mcp__ccd_session__move_to_cloud`: `{summary (required), environment_id?, plan?, skip_push?}`.
- `mcp__ccd_session_mgmt__set_session_permission_mode`: `{session_id (required; "self" allowed), mode (required: default, acceptEdits, plan, auto or bypassPermissions), _consent?, current_mode?, session?}`.

## Recovery

If the guard blocks everything:
1. The developer runs `/plugin disable midas-sdlc@midas-harness`.
2. If that fails, they run this in their own PowerShell, not Claude's:
   `& (Get-ChildItem $env:LOCALAPPDATA/Claude-Data/*/claude-code/*/*/claude.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName plugin disable midas-sdlc@midas-harness`
   The lookup finds the bundled CLI. Its literal path today is `C:\Users\dev\AppData\Local\Claude-Data\claude_abc123\claude-code\2.1.321\d0e23af87588\claude.exe`, and the version folder changes when the app updates. `CLAUDE_CODE_EXECPATH` exists only inside Claude's process, so it can't be used here. The README's Recovery section holds the same lookup.
3. Failing that, they set `"midas-sdlc@midas-harness": false` under `enabledPlugins` in `C:\Users\dev\.claude\settings.json` by hand, then restart the session.

Never uninstall midas-sdlc; disable it. Uninstalling deletes the plugin's data folder, and the gate record with it. Uninstalling midas-probe without `--keep-data` on 13 Nov 2026 deleted its data folder and left its cache copy (see the uninstall row in [Results](#results)).

## Known escapes

- Scripts more than one level deep.
- Commands built at run time, including paths built at run time.
- Decoded payloads.
- Globbed or brace-expanded command names.
- Code that git or a build runs without being named in the command. The reviewer flags changes to these files:
  - git hooks in tracked folders such as `.husky`;
  - csproj Exec targets;
  - `Directory.Build.*` files;
  - package.json scripts.
- Clicks in an Azure DevOps tab the developer opened.
- Browser redirects, `data:` pages and script-built URLs that reach Azure DevOps.
- Browser back and forward to an Azure DevOps page the developer opened.
- WebFetch to an Azure DevOps host. No hook watches it, and it can't use the developer's sign-in.
- Claude Docs and artifact publishing, which the session's own rules cover.
- Prompts relayed from other people through Slack, Teams or project threads, until build check 3 shows how they are marked.
