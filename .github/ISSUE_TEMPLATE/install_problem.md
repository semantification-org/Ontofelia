---
name: Installation Problem
about: The one-command installer or a fresh setup failed
title: '[Install] '
labels: bug, install
assignees: ''
---

## What failed
The step where it went wrong (e.g. `install.sh` step 4, first `gateway start`, `ontofelia auth login`).

## Installer output
Paste the relevant output — the last ~30 lines are usually enough.

```
(output here)
```

## Environment
- **OS + version**:
- **Node.js version** (`node --version`):
- **pnpm version** (`pnpm --version`):
- **Rust installed?** (`rustc --version`, if the reasoner build failed):
- **Fresh clone or update of an existing install?**

## Gateway log (if the gateway failed to start)
The tail of `~/.ontofelia/logs/gateway.log`, if it exists.

```
(log here)
```
