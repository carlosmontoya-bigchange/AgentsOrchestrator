---
format: 1
min_plugin: 0.1.0
layer: base
pod: example
---

# Pod

Free notes are allowed anywhere outside the fenced block.

```json
{ "name": "example", "tracker": { "type": "none" } }
```

# Repos

```json
[ { "id": "dev.azure.com/org/proj/_git/app", "name": "App", "trunk": "main",
    "build": "dotnet build App.slnx", "test": { "win32": "dotnet test App.slnx", "linux": "dotnet test App.slnx" },
    "env": ["NUGET_TOKEN"], "specialists": [ { "glob": "**/*.sql", "agent": "database" }, { "glob": "**", "agent": "backend" } ] } ]
```

# Policies

```json
[ { "id": "pod-dod", "statement": "A change meets the Definition of Done before review.", "applies_to": "review", "check": "review", "source": "https://example.invalid/wiki/dod" } ]
```
