---
name: export
description: Writes the pod's base configuration to one markdown file a pod lead can hand to the team. Use when a pod lead wants to share, export or standardise the pod harness set-up for their team members.
---

# Export the pod base file

Write the pod's base configuration to a file the pod lead can share. Team members import it with `/pod-harness:setup`.

## Rules

- Run the CLI and act on its JSON. Never write or copy the configuration files yourself.
- The file holds no secret, no local path and nothing personal. Do not add any.
- The file must not be saved inside a git repo: the pod's configuration is never pushed. The CLI refuses a folder inside a repo.
- If the developer gives a home folder for testing, start every command with `POD_HARNESS_HOME="<folder>"` in Bash. In PowerShell run `$env:POD_HARNESS_HOME = '<folder>'` once first.

## Steps

1. Ask where to save the file. Propose a folder outside every repo, such as the Documents folder, and the file name `<pod>-base.md`.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" export <file>`.
   - Error `inside-repo`: say the folder is inside a git repo and ask for another one.
   - Error `no-base` or `no-pod`: say the pod is not set up yet and that `/pod-harness:setup` starts it.
   - Error `exists`: a file is already there. Ask whether to replace it. Only on a yes, run the command again with `--force` after the file name.
   - Error `invalid-base`: show the problems in the message and stop. The pod lead fixes them with `/pod-harness:setup`, then exports again.
3. Tell the pod lead where the file is, and:
   - share it through the channel the pod already uses for files;
   - do not commit it to a repo;
   - each member runs `/pod-harness:setup`, answers "yes" to having a base file, and gives its path;
   - members can change their own copy afterwards, and `/pod-harness:doctor` shows them where they differ.
