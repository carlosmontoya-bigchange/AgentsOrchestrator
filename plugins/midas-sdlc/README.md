# midas-sdlc

A Claude Code plugin for the Midas SDLC. Its guard blocks outward actions until the developer answers in chat:
Azure DevOps writes, Azure DevOps pages in the browser, and session, schedule and app-setting tools. Its recorder
stores those answers (`Accept G<n> <id>`, `Approve: ...`) in a gate ledger.

This is a snapshot of a developer's local harness, still being built. The guard's rules are in
`docs/superpowers/specs/2026-11-11-midas-sdlc-guard-design.md`.

## Install

At user scope only. In the Claude Code desktop app:

1. `/plugin marketplace add carlosmontoya-bigchange/AgentsOrchestrator` (a private repo: your git must be able to clone it). A local clone works too: `/plugin marketplace add <path to the clone>`
2. `/plugin install midas-sdlc@agents-orchestrator`, choosing user scope
3. `/reload-plugins`

From here, every Azure DevOps write in every session needs an answer.

## Update

Claude Code installs a copy of the plugin and keeps it until the plugin's `version` changes. To get a new version,
in your own PowerShell (not Claude's):

```powershell
$c = (Get-ChildItem $env:LOCALAPPDATA/Claude-Data/*/claude-code/*/*/claude.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
& $c plugin marketplace update agents-orchestrator
& $c plugin update midas-sdlc@agents-orchestrator
```

Then run `/reload-plugins` in each open session in the desktop app, or start a new session. If the update says
`already at the latest version`, no new version has been published yet.

To get updates without asking, open `/plugin`, go to **Marketplaces**, choose `agents-orchestrator` and turn on
**Enable auto-update**. Claude Code then checks shortly after each session starts and tells you to run
`/reload-plugins`.

## What it blocks

Reads always pass. Until the developer answers, the guard denies:

- **Azure DevOps writes** through either Azure DevOps MCP server: work items, comments, links, test cases, PRs,
  reviewers, merges and pipeline runs. Some actions are never allowed, such as a merge into BigChange.Database.
- **Azure DevOps pages in the browser** (built-in browser and Claude in Chrome). No answer allows these.
- **Session, schedule and app-setting tools**: SendMessage, session start and hand-off, scheduled tasks, CronCreate,
  RemoteTrigger, PublishPlugin and app settings, whenever their text carries an answer line. Answers only count
  when the developer types them.

A denial names the answer that would allow the action. Claude then stops and asks you.

## Answers

An answer is a whole message, typed by you: not pasted, not a slash command, not from a subagent or a schedule.
It arms the actions for that message only. The next message clears it.

| Type | To allow |
| --- | --- |
| `Accept G<n> <id>` | The actions of gate n on work item id (gates below) |
| `Accept G8b PR<n>` | Publishing PR n and adding its reviewers |
| `Accept G11 PR<n>` | Merging PR n |
| `Refuse G<n> <id>: <reason>` / `Skip G<n> <id>: <reason>` | Nothing; records the decision |
| `Pause <id>: <reason>` | Nothing; records the pause |
| `Take <id>` / `Tested <id>` | Peer testing a teammate's item |
| `Approve: comment <id>` | Comments on id |
| `Approve: update <id>` | Field, state and column changes on id |
| `Approve: create item` (or typing `Create it.`) | Creating one work item |
| `Approve: review PR<n>` | Comments, thread status and your vote on PR n |
| `Approve: reply PR<n>` | Thread replies and title or description edits on PR n, no vote |
| `Approve: push <branch>` | A plain push of that branch, unless protected or midas/dev |
| `Approve: pipeline <definition id>` | Runs of that pipeline |

Answers are exact. A trailing period, `#<id>`, or a reason after an Accept arms nothing. The guard tells Claude the
accepted forms when it can't read one.

## Gates

| Gate | Allows on the item |
| --- | --- |
| G0 | Assigning it and moving it to Active (support tickets) |
| G1, G2 | Field edits with no state change, and comments |
| G3, G5, G6, G7 | Nothing; records the stage decision |
| G4 | Assigning it and moving it to Implementation |
| G8 | Pushing a branch named with the id, a draft PR to the trunk or a Release branch, and links to it |
| G8b | Publishing its PRs and adding reviewers, and moving it to Approval |
| G9 | Deploys: the container pipeline runs |
| G9b | Moving it to Ready for testing, comments and test cases |
| G10 | Nothing; records the teammate's test pass |
| G11 | Merging the PR (`Accept G11 PR<n>`) |
| G12 | Field edits, and creating one Change Request |
| G13 | Close-out: edits, comments, one follow-on item, and closing it once a tester passed it after the last push or deploy |

Every answer is appended to the ledger, and to `work/<id>/gates.log` for the item. The full rules, including
every action class, are in `docs/superpowers/specs/2026-11-11-midas-sdlc-guard-design.md`.

## Limits

- Built for one setup: the workspace is assumed to be `C:\dev\Projects\BigChange`, on Windows, with the
  Claude Code desktop app.
- Shell and file-path rules (git pushes, harness edits) are designed but not yet switched on.
- Install it once. Two copies of the plugin, from two marketplaces, would both guard every call.

## Switch off

`/plugin disable midas-sdlc@agents-orchestrator`. `/plugin enable midas-sdlc@agents-orchestrator` turns it back on.

## Recovery

If the guard blocks too much, none of these steps goes through a hooked tool:

1. `/plugin disable midas-sdlc@agents-orchestrator`.
2. In your own PowerShell, not Claude's:
   `& (Get-ChildItem $env:LOCALAPPDATA/Claude-Data/*/claude-code/*/*/claude.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName plugin disable midas-sdlc@agents-orchestrator`
3. Set `"midas-sdlc@agents-orchestrator": false` under `enabledPlugins` in `~/.claude/settings.json`, then restart.

Never uninstall it: uninstalling deletes the gate ledger unless `--keep-data` is passed. Disable it instead.

## Gate ledger

The ledger is `ledger.jsonl` in the plugin data folder (`~/.claude/plugins/data/midas-sdlc-agents-orchestrator/`).
Claude never edits it, and the hooks only append. To remove a bad line, back the file up, delete the line in your
own editor, keep LF endings and the final newline, then check every line parses:

`node -e "require('fs').readFileSync(process.argv[1],'utf8').split('\n').filter(Boolean).forEach((l,i)=>JSON.parse(l))" <path>`

## Tests

`node --test` from this folder. Dry runs use the fake work item ids 999999000 to 999999099 only.
