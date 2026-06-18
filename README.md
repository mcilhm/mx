# MX CLI

A monorepo CLI that scaffolds and runs **backend (Bun workspaces)** + **frontend (Turborepo)** apps from a single root.

## Structure

```
root/
├── backend/                    Bun workspaces
│   ├── packages/<shared>       (optional, mx pkg:add)
│   └── apps/<name>/
└── frontend/                   Turborepo
    ├── packages/<shared>
    └── apps/<name>/
```

## Install (global)

```bash
bun install      # commander + types
bun link         # registers `mx` globally
```

Binary lives at `~/.bun/bin/mx`.

## Commands

| Command | Purpose |
|---|---|
| `mx init` | Scaffold monorepo (prompts: PM + scope) |
| `mx add:be <n>` / `mx add:fe <n>` | Scaffold new app |
| `mx add <n>` | Interactive kind prompt |
| `mx remove <be\|fe> <n>` | Delete app (re-links workspace) |
| `mx rename <be\|fe> <old> <new>` | Rename app + package.json |
| `mx pkg:add <be\|fe> <n>` | Create shared package |
| `mx link <be\|fe> <app> <pkg>` | Add workspace dep to app |
| `mx list` / `mx list --json` | List all apps |
| `mx doctor` | Health checks |
| `mx run <be\|fe\|all> <name> <script>` | Run script |
| `mx exec <be\|fe> <n> -- <cmd>` | Run arbitrary command inside app |
| `mx format` | Prettier/biome across all apps |
| `mx typecheck` | tsc --noEmit across all apps (parallel) |
| `mx audit` | CVE scan via package manager |
| `mx outdated` | Check for outdated deps |
| `mx stats` | Apps, LOC, deps, disk usage, last commit |
| `mx graph` | Dependency graph (ASCII or DOT) |
| `mx logs <be\|fe> <name>` | Tail app log (no pm2 needed) |
| `mx shell <be\|fe> <name>` | Drop to shell in app folder |
| `mx envdiff <be\|fe> <a> <b>` | Compare env keys between two apps |
| `mx clean` / `mx fresh` | Remove build artifacts / clean + reinstall |
| `mx setup --husky` | Install husky + lint-staged git hooks |

## Initialize

```bash
mx init                                    # interactive
mx init --pm bun --scope all               # full monorepo with bun
mx init --pm pnpm --scope backend          # backend-only
mx init --pm bun  --scope frontend         # frontend-only
```

Flags:
- `--pm <bun|pnpm|yarn|npm>` — package manager
- `--scope <backend|frontend|all>` — what to scaffold

**Auto-install:** after scaffolding, `mx init` runs `<pm> install` automatically for the root, `backend/`, and `frontend/`. Re-runs are safe — if `node_modules` already exists, the step is skipped.

Persisted to `.mx/config.json`.

## Add apps

```bash
mx add:be api                              # default: no DB, port 3001
mx add:be api --db postgres --with-auth    # postgres + auth module
mx add:be api --port 4000 --no-cors
mx add:fe web                              # Next.js, port auto (3000, 3001, ...)
mx add:fe web --port 3100
mx add api                                 # interactive (prompts kind)
```

BE template includes `zod`-validated `src/env.ts` that auto-loads `.env` and fails fast on missing/invalid vars.

## Shared packages

```bash
mx pkg:add be types                        # creates backend/packages/types
mx link be api types                       # adds be-types to backend/apps/api deps
```

Import in app code: `import { PACKAGE_NAME } from "be-types";`

## Run / exec

```bash
mx run be api dev                  # run a script in one app
mx run all dev                     # parallel across all apps
mx run all build

mx exec be api -- bun test         # arbitrary command (or script name)
mx exec be api -- lint             # invokes `bun run lint` if defined in pkg
```

## Quality

```bash
mx doctor                          # PM, lockfile, ports, scripts, orphans
mx format                          # prettier/biome across all apps
mx typecheck                       # tsc --noEmit in parallel
mx audit                           # CVE scan via bun/pnpm/yarn/npm audit
mx outdated                        # check for newer dep versions
mx setup --husky                   # husky + lint-staged
```

## Observability

```bash
mx stats                           # apps count, LOC, deps count, disk, last commit
mx graph                           # dep graph as ASCII
mx graph --dot > deps.dot          # Graphviz DOT format
mx envdiff be api worker           # compare env keys between two apps
```

## Logs (no pm2)

Start an app with `--log` to capture output to `.mx/logs/<prefix>-<name>.log`:

```bash
mx run be api dev --log            # writes to .mx/logs/be-api.log
mx run all dev --log               # one log per app
mx logs                            # list all log files
mx logs be api -n 200              # show last 200 lines
mx logs be api -f                  # tail -f the log
```

## Maintenance

```bash
mx clean                           # remove node_modules, dist, .next, .turbo
mx clean --dry                     # preview what would be removed
mx clean backend                   # only backend
mx fresh                           # clean + reinstall all
mx fresh frontend                  # clean + reinstall frontend only
mx shell be api                    # open cmd.exe/sh inside backend/apps/api
```

## Updating the CLI

```bash
bun install
bun link --force
```

## Uninstalling

```bash
bun unlink
```
