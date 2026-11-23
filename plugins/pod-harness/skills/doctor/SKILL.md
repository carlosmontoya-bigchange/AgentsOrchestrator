---
name: doctor
description: Health check for the pod harness set-up. Use when someone asks whether their pod harness is set up correctly, why it will not run, what is missing, or how their settings differ from the pod's base file.
---

# Pod harness health check

Check the developer's pod configuration and say plainly what works, what does not and how to fix it.

## Rules

- Run the CLI and act on its JSON. Never write or edit the configuration files yourself.
- Never ask for, print or store a secret. If a check needs one, name the environment variable only.
- If the developer gives a home folder for testing, start every command with `POD_HARNESS_HOME=<folder>`.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" doctor`. If it prints the error `no-pod`, say that nothing is set up yet and that `/pod-harness:setup` starts it. Stop there.
2. `environment`: show each check that is not `ok`, with its `fix`.
3. `problems`: show each one with level `error` and the command that fixes it, `/pod-harness:setup <step>`, using the problem's `step`. Show `info` entries in one line each; they are not faults.
4. `access`: show each remote that is not `ok`, with its `fix`.
5. Tracker: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" show`. If `pod.tracker.type` is not `none`, make one read-only call with the tracker tools this session has. If there are none or the call fails, say the tracker connection is missing and show `pod.help.tracker` if it is set.
6. Skills: for every skill named under `skills` in the configuration, check that this session lists it. Report any that is missing.
7. `differs`: list where the developer's settings differ from the pod base. This is information, not a fault.

Finish with one line: either "Everything the harness needs is in place." or the count of things to fix, most important first.
