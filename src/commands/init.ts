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
  SCOPE_OPTIONS,
  Scope,
  detectPkgManager,
  isValidPm,
  isValidScope,
  promptChoice,
} from "../utils";
import { mkdir, readFile } from "node:fs/promises";

const CONFIG_PATH = pathJoin(ROOT, ".mx/config.json");

export async function init(opts: { pm?: string; scope?: string } = {}) {
  log.step("Initializing monorepo skeleton...");

  // Resolve package manager
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

  // Resolve scope (what to initialize)
  let scope: Scope;
  if (opts.scope && isValidScope(opts.scope)) {
    scope = opts.scope;
    log.info(`Scope: ${scope} (from --scope flag)`);
  } else if (opts.scope) {
    log.warn(`invalid --scope '${opts.scope}', valid: backend | frontend | all`);
    scope = await resolveScopeInteractive();
  } else {
    scope = await promptChoice(
      "What do you want to initialize?",
      SCOPE_OPTIONS,
      "all"
    );
  }

  await saveConfig(pm, scope);
  log.info(`Using package manager: ${pm}, scope: ${scope}`);

  const dirs: string[] = [".mx"];
  if (scope === "backend" || scope === "all") dirs.push(KIND_DIR.backend);
  if (scope === "frontend" || scope === "all") dirs.push(KIND_DIR.frontend);

  for (const d of dirs) {
    const p = pathJoin(ROOT, d);
    if (exists(p)) {
      log.warn(`already exists: ${d}/`);
    } else {
      await ensureDir(p);
      log.ok(`created: ${d}/`);
    }
  }

  if (scope === "backend" || scope === "all") {
    await ensureDir(pathJoin(ROOT, "backend/apps"));
    await renderRootConfig("backend", pm);
  }
  if (scope === "frontend" || scope === "all") {
    await ensureDir(pathJoin(ROOT, "frontend/apps"));
    await renderRootConfig("frontend", pm);
  }

  // Umbrella root package.json (only if at least one side initialized)
  const rootPkgPath = pathJoin(ROOT, "package.json");
  if (!exists(rootPkgPath) && scope !== "all") {
    const scripts: Record<string, string> = {};
    if (scope === "backend") {
      scripts.dev = `cd backend && ${pm} run dev`;
      scripts.build = `cd backend && ${pm} run build`;
      scripts["dev:be"] = scripts.dev;
      scripts["build:be"] = scripts.build;
    } else if (scope === "frontend") {
      scripts.dev = `cd frontend && ${pm} run dev`;
      scripts.build = `cd frontend && ${pm} run build`;
      scripts["dev:fe"] = scripts.dev;
      scripts["build:fe"] = scripts.build;
    }
    const rootPkg: any = {
      name: pathJoin(ROOT).split(/[\\/]/).filter(Boolean).pop() ?? "monorepo",
      private: true,
      version: "0.1.0",
      scripts,
    };
    if (pm === "bun") rootPkg.packageManager = "bun@1.3.14";
    await writeFile(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n", "utf8");
    log.ok(`created: ./package.json (umbrella scripts, pm=${pm}, scope=${scope})`);
  } else if (!exists(rootPkgPath) && scope === "all") {
    await writeUmbrellaRoot(pm);
  } else {
    log.warn("package.json already exists, skipping root setup");
  }

  const rootReadme = `# Monorepo (scope: ${scope})

${scope === "all" ? "```\nbackend/  workspaces  (apps/*)\nfrontend/ workspaces  (apps/*)\n```" : ""}
${scope === "backend" ? "Backend-only mode. Use `mx init --scope all --pm <pm>` later to add frontend." : ""}
${scope === "frontend" ? "Frontend-only mode. Use `mx init --scope all --pm <pm>` later to add backend." : ""}

Package manager: **${pm}**

Dependencies are installed automatically by \`mx init\`. If anything fails, re-run:
\`\`\`bash
${pm} install                # root${scope === "backend" || scope === "all" ? "\ncd backend && " + pm + " install" : ""}${scope === "frontend" || scope === "all" ? "\ncd frontend && " + pm + " install" : ""}
\`\`\`

${scope === "backend" || scope === "all" ? "## Backend\n\n```bash\nmx add:be <name>\n```\n" : ""}${scope === "frontend" || scope === "all" ? "## Frontend\n\n```bash\nmx add:fe <name>\n```\n" : ""}
`;
  await writeFile(pathJoin(ROOT, ".mx/README.md"), rootReadme, "utf8");

  log.ok(`Monorepo initialized (scope=${scope}).`);

  // Auto-install: root (umbrella) + each side
  await autoInstall(pm, scope);

  printNextSteps(pm, scope);
}

async function autoInstall(pm: PackageManager, scope: Scope) {
  log.step(`Installing dependencies with ${pm}...`);

  const tasks: { label: string; dir: string; optional: boolean }[] = [];
  if (exists(pathJoin(ROOT, "package.json"))) {
    tasks.push({ label: "root", dir: ROOT, optional: false });
  }
  if (scope === "backend" || scope === "all") {
    tasks.push({ label: "backend", dir: pathJoin(ROOT, KIND_DIR.backend), optional: false });
  }
  if (scope === "frontend" || scope === "all") {
    tasks.push({ label: "frontend", dir: pathJoin(ROOT, KIND_DIR.frontend), optional: false });
  }

  if (tasks.length === 0) {
    log.warn("nothing to install");
    return;
  }

  for (const t of tasks) {
    if (!exists(pathJoin(t.dir, "package.json"))) {
      log.warn(`skipping ${t.label}: no package.json`);
      continue;
    }
    // Skip if already installed
    if (exists(pathJoin(t.dir, "node_modules"))) {
      log.info(`skipping ${t.label} (node_modules already present)`);
      continue;
    }
    log.info(`installing ${t.label} (${pm} install)...`);
    const proc = Bun.spawn([pm, "install"], {
      cwd: t.dir,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ADBLOCK: "1", NPM_CONFIG_FUND: "false" },
    });
    const code = await proc.exited;
    if (code !== 0) {
      log.warn(`${t.label} install exited with code ${code} (you can re-run \`${pm} install\` manually)`);
    } else {
      log.ok(`${t.label} installed`);
    }
  }
}

function printNextSteps(pm: PackageManager, scope: Scope) {
  log.info("Next:");
  if (scope === "backend" || scope === "all") {
    log.info("  mx add:be <name>");
  }
  if (scope === "frontend" || scope === "all") {
    log.info("  mx add:fe <name>");
  }
  log.info("  mx list");
  log.info(`  mx doctor   # verify everything is healthy`);
}

async function writeUmbrellaRoot(pm: PackageManager) {
  const rootPkgPath = pathJoin(ROOT, "package.json");
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
    ...(pm === "bun" ? { packageManager: "bun@1.3.14" } : {}),
  };
  await writeFile(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n", "utf8");
  log.ok(`created: ./package.json (umbrella scripts, pm=${pm})`);
}

async function resolvePmInteractive(): Promise<PackageManager> {
  return (await promptChoice(
    "Which package manager do you want to use?",
    PM_OPTIONS,
    "bun"
  )) as PackageManager;
}

async function resolveScopeInteractive(): Promise<Scope> {
  return (await promptChoice(
    "What do you want to initialize?",
    SCOPE_OPTIONS,
    "all"
  )) as Scope;
}

async function saveConfig(pm: PackageManager, scope: Scope) {
  await ensureDir(pathJoin(ROOT, ".mx"));
  await writeFile(
    CONFIG_PATH,
    JSON.stringify({ packageManager: pm, scope }, null, 2) + "\n",
    "utf8"
  );
}

async function renderRootConfig(kind: "backend" | "frontend", pm: PackageManager) {
  const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
  const tplDir = pathJoin(TEMPLATES_DIR, kind);
  if (!exists(tplDir)) return;

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

function pmVersionHint(pm: PackageManager): string {
  switch (pm) {
    case "bun": return "bun@1.3.14";
    case "pnpm": return "pnpm@9";
    case "yarn": return "yarn@1.22";
    case "npm": return "npm@10";
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
