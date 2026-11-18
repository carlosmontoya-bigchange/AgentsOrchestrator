# AgentsOrchestrator

## Plugins

- [midas-sdlc](plugins/midas-sdlc/README.md): gated Midas SDLC stages and the outward-action guard for Claude Code.

## Use it as a plugin marketplace

In Claude Code:

1. `/plugin marketplace add carlosmontoya-bigchange/AgentsOrchestrator`
2. `/plugin install <plugin>@agents-orchestrator`
3. `/reload-plugins`

The repo is private, so your git must be able to clone it. To update an installed plugin, see its README.



## Publishing a change

Raise the plugin's `version` in its `.claude-plugin/plugin.json` in the same push. Claude Code keeps the installed copy until the version changes, so a push without a new version reaches nobody.
