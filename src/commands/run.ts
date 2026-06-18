import {
  exists,
  log,
  pathJoin,
  ROOT,
  AppKind,
  KIND_APPS_DIR,
  kindLabel,
  PackageManager,
  detectPkgManager,
  isValidPm,
  pmRunArgs,
} from "../utils";
import { readdir, readFile } from "node:fs/promises";

const CONFIG_PATH = pathJoin(ROOT, ".mx/config.json");

async function loadPm(): Promise<PackageManager> {
  if (exists(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
      if (isValidPm(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return detectPkgManager();
}

function appKind(prefix: "be" | "fe"): AppKind {
  return prefix === "be" ? "backend" : "frontend";
}

function appDir(prefix: "be" | "fe", name: string): string {
  return pathJoin(ROOT, KIND_APPS_DIR[appKind(prefix)], name);
}

function runArgs(pm: PackageManager, script: string): string[] {
  return pmRunArgs(pm, script);
}

async function loadEnv(dir: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const file of [".env.local", ".env"]) {
    const p = pathJoin(dir, file);
    if (!exists(p)) continue;
    try {
      const raw = await readFile(p, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) env[key] = val;
      }
      log.info(`loaded ${file}`);
    } catch {}
  }
  return env;
}

function mergeEnv(fileEnv: Record<string, string>): NodeJS.ProcessEnv {
  return { ...fileEnv, ...process.env } as NodeJS.ProcessEnv;
}

export async function run(kind: Kind, name: string, script: string) {
  const pm = await loadPm();

  if (kind === "all") {
    return runAll(script, pm);
  }

  const prefix: "be" | "fe" = kind;
  const dir = appDir(prefix, name);
  if (!exists(dir)) {
    log.err(`App not found: ${dir}`);
    process.exit(1);
  }
  if (!exists(pathJoin(dir, "package.json"))) {
    log.err(`No package.json in ${dir}`);
    process.exit(1);
  }

  const fileEnv = await loadEnv(dir);
  log.info(`$ ${pm} ${runArgs(pm, script).join(" ")}  (in ${KIND_APPS_DIR[appKind(prefix)]}/${name})`);
  const proc = Bun.spawn([pm, ...runArgs(pm, script)], {
    cwd: dir,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...mergeEnv(fileEnv), FORCE_COLOR: "1" },
  });
  const code = await proc.exited;
  process.exit(code);
}

async function runAll(script: string, pm: PackageManager) {
  const dirs: { prefix: "be" | "fe"; kind: AppKind }[] = [
    { prefix: "be", kind: "backend" },
    { prefix: "fe", kind: "frontend" },
  ];

  const targets: { prefix: "be" | "fe"; kind: AppKind; name: string; dir: string }[] = [];
  for (const { prefix, kind } of dirs) {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(base)) continue;
    const entries = await readdir(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = pathJoin(base, e.name);
      if (!exists(pathJoin(dir, "package.json"))) continue;
      targets.push({ prefix, kind, name: e.name, dir });
    }
  }

  if (targets.length === 0) {
    log.warn("No apps found under backend/apps or frontend/apps.");
    log.info("Create one first: mx add:be api  /  mx add:fe web");
    return;
  }

  log.step(`Running '${script}' on ${targets.length} app(s) in parallel...`);

  const procs = await Promise.all(
    targets.map(async (t) => {
      const args = runArgs(pm, script);
      const fileEnv = await loadEnv(t.dir);
      log.info(`starting ${kindLabel(t.kind)}/${t.name}: ${pm} ${args.join(" ")}`);
      return {
        ...t,
        proc: Bun.spawn([pm, ...args], {
          cwd: t.dir,
          stdio: ["inherit", "inherit", "inherit"],
          env: { ...mergeEnv(fileEnv), FORCE_COLOR: "1" },
        }),
      };
    })
  );

  const codes = await Promise.all(procs.map((p) => p.proc.exited));
  const failed = procs.filter((_, i) => codes[i] !== 0);

  if (failed.length > 0) {
    log.err(`${failed.length} process(es) failed:`);
    for (const f of failed) log.err(`  - ${kindLabel(f.kind)}/${f.name} (exit ${codes[procs.indexOf(f)]})`);
    process.exit(1);
  }
  log.ok("All apps finished cleanly.");
}
