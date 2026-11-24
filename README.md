# AgentsOrchestrator

## Plugins

- [pod-harness](plugins/pod-harness/README.md): one way of working with Claude Code for a pod. A guided set-up with a base file a pod lead can share, and a task flow through understand, build, test and review.

## Use it as a plugin marketplace

In Claude Code:

1. `/plugin marketplace add carlosmontoya-bigchange/AgentsOrchestrator`
2. `/plugin install <plugin>@agents-orchestrator`
3. `/reload-plugins`

The repo is private, so your git must be able to clone it. To update an installed plugin, see its README.

The midas-sdlc plugin was retired on 2026-11-23 and is no longer listed. If you still have it installed, remove it: `/plugin uninstall midas-sdlc@agents-orchestrator`.



## Publishing a change

Raise the plugin's `version` in its `.claude-plugin/plugin.json` in the same push. Claude Code keeps the installed copy until the version changes, so a push without a new version reaches nobody.
