---
format: 1
min_plugin: 0.1.0
layer: defaults
pod: org
---

Org defaults for every pod. A pod base or a personal file overrides any value here.
The numbers under Teams and Budget are provisional until the first dry runs.

# Stages

```json
{ "design": true, "plan": true, "test": true, "review": true, "deliver": true }
```

# Teams

```json
{
  "max_agents_per_stage": 4,
  "max_same_kind": 2,
  "models": {
    "orchestrator": "opus",
    "orchestrator_small": "sonnet",
    "explorer": "haiku",
    "architect": "sonnet",
    "backend": "sonnet",
    "frontend": "sonnet",
    "database": "sonnet",
    "tester": "sonnet",
    "reviewer": "opus",
    "reviewer_trivial": "sonnet",
    "delivery": "sonnet",
    "advocate": "sonnet",
    "critic": "sonnet",
    "arbiter": "opus"
  }
}
```

# Reports

```json
{ "sonnet_lines": 40, "opus_lines": 80, "language": "en" }
```

# Trivial

```json
{
  "max_files": 3,
  "max_lines": 50,
  "max_test_lines": 150,
  "never": [
    "**/migrations/**",
    "**/*.sql",
    "**/*.csproj",
    "**/Directory.Packages.props",
    "**/packages.config",
    "**/package.json",
    "**/*.yml",
    "**/*.yaml",
    "**/*.tf",
    "**/appsettings*.json",
    "**/web.config",
    "**/*Contract*/**",
    "**/*Permission*",
    "**/*Auth*",
    "**/*FeatureFlag*"
  ]
}
```

# Policies

```json
[
  { "id": "org-no-secrets", "statement": "No secret in a prompt, a file or a report.", "applies_to": "all", "check": "review" },
  { "id": "org-no-customer-data", "statement": "No customer data on disk or in a report.", "applies_to": "all", "check": "review" },
  { "id": "org-outward-in-deliver", "statement": "Outward actions happen only in the Deliver stage.", "applies_to": "all", "check": "review" }
]
```

# Skills

```json
{}
```

# Approvals

```json
{
  "work_order": true,
  "design": true,
  "plan": true,
  "review_result": true
}
```

# Delivery

```json
{ "actor": "main", "remotes": [], "webhooks": [], "manual_tests": "", "never": [], "always_ask": [] }
```

# Budget

```json
{ "tokens_per_stage": 500000, "max_turns": 40, "debate": true }
```
