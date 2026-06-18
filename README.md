# MX CLI

A monorepo CLI that scaffolds and runs **backend (Bun workspaces)** + **frontend (Turborepo)** apps from a single root.

## Structure

```
root/
├── backend/
│   ├── package.json        # Bun workspaces
│   ├── README.md
│   └── apps/
│       ├── api             # be-api
│       └── worker          # be-worker
└── frontend/
    ├── package.json        # Turborepo root
    ├── turbo.json
    ├── README.md
    └── apps/
        ├── web             # fe-web
        └── admin           # fe-admin
```

## Install (global)

```bash
bun install      # install commander + types
bun link         # registers `mx` globally
```

Binary lives at `~/.bun/bin/mx` (Windows: `C:\Users\<you>\.bun\bin\mx.exe`).

## Usage

### Initialize

```bash
mx init                  # interactive: choose package manager
mx init --pm bun         # non-interactive: bun | pnpm | yarn | npm
```

The CLI will ask which package manager to use (or use `--pm` to skip the prompt). It writes the choice to `.mx/config.json` so `mx add:*` and `mx run` always use the same PM.

Creates `backend/` (workspaces) + `frontend/` (Turborepo) with their own root `package.json` configured for your chosen PM, plus an umbrella `package.json` at the repo root.

### Add apps

```bash
mx add:be <name>    # Bun + Elysia backend
mx add:fe <name>    # Next.js 14 frontend
```

- Each app is named `be-<name>` / `fe-<name>`.
- Each app gets a `.env.example`.
- BE default port `3001`; FE ports auto-increment from `3000`.
- After scaffolding, the corresponding root workspace install runs (`cd backend && bun install` or `cd frontend && bun install`).

### Per-workspace commands

After `mx init` you can also drive each side natively:

```bash
cd backend  && bun install && bun run dev     # Bun workspaces filter
cd frontend && bun install && bun run dev     # turbo run dev
```

### List apps

```bash
mx list            # pretty table
mx list --json     # JSON
```

Shows kind, path, name, port, `.env` presence, scripts.

### Run apps

```bash
mx run be api dev        # single backend
mx run fe web dev        # single frontend
mx run all dev           # run ALL backend + frontend apps in parallel
mx run all build
```

### Env files

Each app can have `.env` / `.env.local`. `mx run` auto-loads them; existing `process.env` values win.

## Updating

```bash
bun install
bun link --force
```

## Uninstalling

```bash
bun unlink
```
