# midas-sdlc

A Claude Code plugin for the Midas SDLC. Its guard blocks outward actions until the developer answers in chat:
Azure DevOps writes, Azure DevOps pages in the browser, and session, schedule and app-setting tools. Its recorder
stores those answers (`Accept G<n> <id>`, `Approve: ...`) in a gate ledger.

This is a snapshot of a developer's local harness, still being built. The guard's rules are in
`docs/superpowers/specs/2026-11-11-midas-sdlc-guard-design.md`.

## Install

At user scope only. In the Claude Code desktop app:

1. `/plugin marketplace add <path to this repo>`
2. `/plugin install midas-sdlc@midas-harness`, choosing user scope
3. `/reload-plugins`

From here, every Azure DevOps write in every session needs an answer.

## Switch off

`/plugin disable midas-sdlc@midas-harness`. `/plugin enable midas-sdlc@midas-harness` turns it back on.

## Recovery

If the guard blocks too much, none of these steps goes through a hooked tool:

1. `/plugin disable midas-sdlc@midas-harness`.
2. In your own PowerShell, not Claude's:
   `& (Get-ChildItem $env:LOCALAPPDATA/Claude-Data/*/claude-code/*/*/claude.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName plugin disable midas-sdlc@midas-harness`
3. Set `"midas-sdlc@midas-harness": false` under `enabledPlugins` in `~/.claude/settings.json`, then restart.

Never uninstall it: uninstalling deletes the gate ledger unless `--keep-data` is passed. Disable it instead.

## Gate ledger

The ledger is `ledger.jsonl` in the plugin data folder (`~/.claude/plugins/data/midas-sdlc-midas-harness/`).
Claude never edits it, and the hooks only append. To remove a bad line, back the file up, delete the line in your
own editor, keep LF endings and the final newline, then check every line parses:

`node -e "require('fs').readFileSync(process.argv[1],'utf8').split('\n').filter(Boolean).forEach((l,i)=>JSON.parse(l))" <path>`

## Tests

`node --test` from this folder. Dry runs use the fake work item ids 999999000 to 999999099 only.
