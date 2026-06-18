import {
  exists,
  log,
  pathJoin,
  ROOT,
  TEMPLATES_DIR,
  writeFile,
  AppKind,
  KIND_APPS_DIR,
  KIND_DIR,
  PackageManager,
  detectPkgManager,
  isValidPm,
  pmInstallArgs,
} from "../utils";
import { readdir, readFile, mkdir, writeFile as fsWriteFile, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_PATH = pathJoin(ROOT, ".mx/config.json");

async function loadPmChoice(): Promise<PackageManager> {
  if (exists(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(await fsReadFile(CONFIG_PATH, "utf8"));
      if (isValidPm(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return detectPkgManager();
}

async function renderTemplate(srcDir: string, destDir: string, vars: Record<string, string>) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const relName = entry.name.replace(/\.tmpl$/, "");
    const destPath = pathJoin(destDir, relName);

    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await renderTemplate(srcPath, destPath, vars);
      continue;
    }

    let content = await readFile(srcPath, "utf8");
    for (const [k, v] of Object.entries(vars)) {
      content = content.replaceAll(`__${k}__`, v);
    }
    await writeFile(destPath, content);
  }
}

function usedPort(kind: AppKind): number[] {
  try {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(base)) return [];
    const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
    const ports: number[] = [];
    for (const d of dirs) {
      const pkgPath = pathJoin(base, d.name, "package.json");
      if (exists(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          const m = JSON.stringify(pkg.scripts ?? {}).match(/--port\s+(\d+)/);
          if (m) ports.push(parseInt(m[1], 10));
        } catch {}
      }
    }
    return ports;
  } catch {
    return [];
  }
}

function suggestPort(kind: AppKind, existing: number[]): number {
  const base = kind === "backend" ? 3001 : 3000;
  const used = new Set(existing);
  let port = base;
  while (used.has(port)) port++;
  return port;
}

export async function addBe(name: string) {
  return addApp("backend", "be", name);
}

export async function addFe(name: string) {
  return addApp("frontend", "fe", name);
}

async function addApp(kind: AppKind, prefix: "be" | "fe", name: string) {
  const kindLabel = prefix.toUpperCase();
  log.step(`Scaffolding ${kindLabel} app: ${name} (in ${KIND_APPS_DIR[kind]})`);

  const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
  if (!exists(rootDir) || !exists(pathJoin(rootDir, "package.json"))) {
    log.err(`${KIND_DIR[kind]}/ is not initialized. Run: mx init`);
    process.exit(1);
  }

  const dest = pathJoin(ROOT, KIND_APPS_DIR[kind], name);
  if (exists(dest)) {
    log.err(`App already exists at ${dest}`);
    process.exit(1);
  }

  const tpl = pathJoin(TEMPLATES_DIR, kind, "app");
  if (!exists(tpl)) {
    log.err(`${kind} app template not found at ${tpl}`);
    process.exit(1);
  }

  let vars: Record<string, string> = { APP_NAME: name };
  if (kind === "frontend") {
    vars.PORT = String(suggestPort(kind, usedPort(kind)));
  }

  await renderTemplate(tpl, dest, vars);

  log.ok(`created: ${KIND_APPS_DIR[kind]}/${name}` + (vars.PORT ? ` (port ${vars.PORT})` : ""));
  log.info("Writing .env.example...");
  await fsWriteFile(pathJoin(dest, ".env.example"), envExample(kind, vars.PORT), "utf8");

  await installKindRoot(kind);

  log.ok(`Done. Try: mx run ${prefix} ${name} dev`);
}

function envExample(kind: AppKind, port?: string): string {
  if (kind === "backend") {
    return `# copy to .env (loaded automatically by \`mx run\`)
PORT=3001
DATABASE_URL=
API_KEY=
`;
  }
  return `# copy to .env (loaded automatically by \`mx run\`)
NEXT_PUBLIC_API_URL=http://localhost:3001
PORT=${port ?? 3000}
`;
}

async function installKindRoot(kind: AppKind) {
  const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
  if (!exists(rootDir) || !exists(pathJoin(rootDir, "package.json"))) return;
  const pm = await loadPmChoice();
  log.info(`Installing ${kind} workspace deps (${pm})...`);
  await runPm(pm, rootDir, "install");
}

async function runPm(pm: PackageManager, cwd: string, action: "install", args: string[] = []) {
  const fullArgs = action === "install" ? pmInstallArgs(pm) : [action, ...args];
  log.info(`$ ${pm} ${fullArgs.join(" ")}  (in ${cwd.replace(ROOT, ".")})`);

  const proc = Bun.spawn([pm, ...fullArgs], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    log.warn(`command exited with code ${code}`);
  }
}
