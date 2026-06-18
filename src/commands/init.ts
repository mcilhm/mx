import {
  exists,
  ensureDir,
  log,
  pathJoin,
  ROOT,
  TEMPLATES_DIR,
  writeFile,
  KIND_DIR,
  PackageManager,
  PM_OPTIONS,
  detectPkgManager,
  isValidPm,
  promptChoice,
} from "../utils";
import { mkdir, readFile } from "node:fs/promises";

const CONFIG_PATH = pathJoin(ROOT, ".mx/config.json");

export async function init(opts: { pm?: string } = {}) {
  log.step("Initializing monorepo skeleton...");

  // Resolve package manager: --pm flag > interactive prompt > detected > default (bun)
  let pm: PackageManager;
  if (opts.pm && isValidPm(opts.pm)) {
    pm = opts.pm;
    log.info(`Package manager: ${pm} (from --pm flag)`);
  } else if (opts.pm) {
    log.warn(`invalid --pm '${opts.pm}', valid: bun | pnpm | yarn | npm`);
    pm = await resolvePmInteractive();
  } else {
    const detected = detectPkgManager();
    pm = await promptChoice(
      "Which package manager do you want to use?",
      PM_OPTIONS,
      detected
    );
  }

  await saveConfig(pm);
  log.info(`Using package manager: ${pm}`);

  const dirs = [KIND_DIR.backend, KIND_DIR.frontend, ".mx"];

  for (const d of dirs) {
    const p = pathJoin(ROOT, d);
    if (exists(p)) {
      log.warn(`already exists: ${d}/`);
    } else {
      await ensureDir(p);
      log.ok(`created: ${d}/`);
    }
  }

  await ensureDir(pathJoin(ROOT, "backend/apps"));
  await ensureDir(pathJoin(ROOT, "frontend/apps"));

  await renderRootConfig("backend", pm);
  await renderRootConfig("frontend", pm);

  const rootPkgPath = pathJoin(ROOT, "package.json");
  if (!exists(rootPkgPath)) {
    const rootPkg = {
      name: pathJoin(ROOT).split(/[\\/]/).filter(Boolean).pop() ?? "monorepo",
      private: true,
      version: "0.1.0",
      scripts: {
        "dev:be": `cd backend && ${pm} run dev`,
        "dev:fe": `cd frontend && ${pm} run dev`,
        "build:be": `cd backend && ${pm} run build`,
        "build:fe": `cd frontend && ${pm} run build`,
        dev: "mx run all dev",
        build: "mx run all build",
      },
      ...(pm === "bun"
        ? { packageManager: "bun@1.3.14" }
        : {}),
    };
    await writeFile(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n", "utf8");
    log.ok(`created: ./package.json (umbrella scripts, pm=${pm})`);
  } else {
    log.warn("package.json already exists, skipping root setup");
  }

  const rootReadme = `# Monorepo

\`\`\`
backend/    ${pmWorkspacesLine(pm, "backend")}  (apps/*)
frontend/   ${pmWorkspacesLine(pm, "frontend")}  (apps/*)
\`\`\`

Package manager: **${pm}**

## Quick start

\`\`\`bash
cd backend  && ${pm} install
cd frontend && ${pm} install

mx add:be api
mx add:fe web
mx list
mx run all dev
\`\`\`
`;
  await writeFile(pathJoin(ROOT, ".mx/README.md"), rootReadme, "utf8");

  log.ok("Monorepo initialized.");
  log.info("Next:");
  log.info(`  cd backend  && ${pm} install`);
  log.info(`  cd frontend && ${pm} install`);
  log.info("  mx add:be <name>");
  log.info("  mx add:fe <name>");
  log.info("  mx list");
}

function pmWorkspacesLine(pm: PackageManager, _which: string): string {
  if (pm === "bun") return "Bun workspaces";
  if (pm === "pnpm") return "pnpm workspaces";
  if (pm === "yarn") return "Yarn workspaces";
  if (pm === "turbo") return "Turborepo";
  return "npm workspaces";
}

async function resolvePmInteractive(): Promise<PackageManager> {
  return (await promptChoice(
    "Which package manager do you want to use?",
    PM_OPTIONS,
    "bun"
  )) as PackageManager;
}

async function saveConfig(pm: PackageManager) {
  await ensureDir(pathJoin(ROOT, ".mx"));
  await writeFile(CONFIG_PATH, JSON.stringify({ packageManager: pm }, null, 2) + "\n", "utf8");
}

async function renderRootConfig(kind: "backend" | "frontend", pm: PackageManager) {
  const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
  const tplDir = pathJoin(TEMPLATES_DIR, kind);
  if (!exists(tplDir)) return;

  // Customize root package.json based on PM
  const pkgTpl = pathJoin(tplDir, "package.json.tmpl");
  if (exists(pkgTpl)) {
    let raw = await readFile(pkgTpl, "utf8");
    raw = raw.replaceAll("__PM_VERSION__", pmVersionHint(pm));
    raw = raw.replaceAll("__SCRIPTS__", kind === "backend" ? backendScriptsJson(pm) : frontendScriptsJson(pm));
    raw = raw.replaceAll("__TURBO_DEVDEP__", kind === "frontend" ? turboDevDepJson(pm) : "{}");
    await writeFile(pathJoin(rootDir, "package.json"), raw, "utf8");
    log.ok(`created: ${KIND_DIR[kind]}/package.json (pm=${pm})`);
  }

  const turboTpl = pathJoin(tplDir, "turbo.json.tmpl");
  if (kind === "frontend" && exists(turboTpl)) {
    const raw = await readFile(turboTpl, "utf8");
    await writeFile(pathJoin(rootDir, "turbo.json"), raw, "utf8");
    log.ok(`created: ${KIND_DIR[kind]}/turbo.json`);
  }

  const readmeTpl = pathJoin(tplDir, "README.md.tmpl");
  if (exists(readmeTpl)) {
    let raw = await readFile(readmeTpl, "utf8");
    raw = raw.replaceAll("__PM__", pm);
    await writeFile(pathJoin(rootDir, "README.md"), raw, "utf8");
  }

  if (kind === "frontend") {
    await mkdir(pathJoin(rootDir, "apps"), { recursive: true });
  }
}

function backendScriptsJson(pm: PackageManager): string {
  const obj = (() => {
    if (pm === "bun") {
      return {
        dev: "bun run --filter '*' dev",
        build: "bun run --filter '*' build",
        start: "bun run --filter '*' start",
      };
    }
    if (pm === "pnpm") {
      return {
        dev: "pnpm -r run dev",
        build: "pnpm -r run build",
        start: "pnpm -r run start",
      };
    }
    if (pm === "yarn") {
      return {
        dev: "yarn workspaces run dev",
        build: "yarn workspaces run build",
        start: "yarn workspaces run start",
      };
    }
    return {
      dev: "npm run dev --workspaces --if-present",
      build: "npm run build --workspaces --if-present",
      start: "npm run start --workspaces --if-present",
    };
  })();
  return JSON.stringify(obj, null, 2);
}

function frontendScriptsJson(pm: PackageManager): string {
  const obj = {
    build: `${pm} run turbo run build`,
    dev: `${pm} run turbo run dev`,
    lint: `${pm} run turbo run lint`,
    start: `${pm} run turbo run start`,
  };
  return JSON.stringify(obj, null, 2);
}

function turboDevDepJson(_pm: PackageManager): string {
  return JSON.stringify({ turbo: "2.3.3" }, null, 2);
}

function pmVersionHint(pm: PackageManager): string {
  switch (pm) {
    case "bun": return "bun@1.3.14";
    case "pnpm": return "pnpm@9";
    case "yarn": return "yarn@1.22";
    case "npm": return "npm@10";
  }
}
