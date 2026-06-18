import {
  exists,
  log,
  pathJoin,
  ROOT,
  AppKind,
  KIND_APPS_DIR,
  kindLabel,
  PackageManager,
  ensureDir,
  loadPm,
  pmRunArgs,
} from "../utils";
import { readdir, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";

const LOGS_DIR = pathJoin(ROOT, ".mx/logs");

export interface RunOpts {
  log?: boolean;
}

async function ensureLogsDir() {
  await ensureDir(LOGS_DIR);
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

export async function run(kind: Kind, name: string, script: string, opts: RunOpts = {}) {
  const pm = await loadPm();

  if (kind === "all") {
    return runAll(script, pm, opts);
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
  const args = runArgs(pm, script);
  log.info(`$ ${pm} ${args.join(" ")}  (in ${KIND_APPS_DIR[appKind(prefix)]}/${name})`);
  if (opts.log) {
    await ensureLogsDir();
    const logPath = pathJoin(LOGS_DIR, `${prefix}-${name}.log`);
    log.info(`logging to ${logPath} (use \`mx logs ${prefix} ${name} -f\` to tail)`);
  }
  const stdout = opts.log ? ["inherit", "pipe", "pipe"] as const : ["inherit", "inherit", "inherit"] as const;
  const proc = Bun.spawn([pm, ...args], {
    cwd: dir,
    stdio: stdout,
    env: { ...mergeEnv(fileEnv), FORCE_COLOR: "1" },
  });
  if (opts.log) {
    await ensureLogsDir();
    const logPath = pathJoin(LOGS_DIR, `${prefix}-${name}.log`);
    const writer = createWriteStream(logPath, { flags: "a" });
    const tag = `[${prefix}:${name}]`;
    const tee = (src: ReadableStream<Uint8Array> | undefined) => {
      if (!src) return;
      const decoder = new TextDecoder();
      const pump = async () => {
        const reader = src.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const text = decoder.decode(value, { stream: true });
              process.stdout.write(text);
              writer.write(`${new Date().toISOString()} ${tag} ${text}`);
            }
          }
        } catch {}
      };
      pump();
    };
    tee(proc.stdout);
    tee(proc.stderr);
  }
  const code = await proc.exited;
  process.exit(code);
}

async function runAll(script: string, pm: PackageManager, opts: RunOpts = {}) {
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
      if (opts.log) await ensureLogsDir();
      const proc = Bun.spawn([pm, ...args], {
        cwd: t.dir,
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...mergeEnv(fileEnv), FORCE_COLOR: "1" },
      });
      if (opts.log) {
        await ensureLogsDir();
        const logPath = pathJoin(LOGS_DIR, `${t.prefix}-${t.name}.log`);
        const writer = createWriteStream(logPath, { flags: "a" });
        const tag = `[${t.prefix}:${t.name}]`;
        const tee = (src: ReadableStream<Uint8Array> | undefined) => {
          if (!src) return;
          const decoder = new TextDecoder();
          const pump = async () => {
            const reader = src.getReader();
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                  const text = decoder.decode(value, { stream: true });
                  writer.write(`${new Date().toISOString()} ${tag} ${text}`);
                }
              }
            } catch {}
          };
          pump();
        };
        tee(proc.stdout);
        tee(proc.stderr);
      }
      return { ...t, proc };
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
