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
  appTag,
} from "../utils";
import { readdir, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";

const LOGS_DIR = pathJoin(ROOT, ".mx/logs");

export interface RunOpts {
  log?: boolean;
  watch?: boolean;
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

  // --watch: spawn detached, write to log, register, return immediately
  if (opts.watch) {
    await ensureLogsDir();
    const logPath = pathJoin(LOGS_DIR, `${prefix}-${name}.log`);
    const proc = spawnWatched([pm, ...args], dir, logPath, { ...mergeEnv(fileEnv), FORCE_COLOR: "1" });

    let port: number | undefined;
    try {
      const pkg = JSON.parse(await readFile(pathJoin(dir, "package.json"), "utf8"));
      const m = JSON.stringify(pkg.scripts ?? {}).match(/--port\s+(\d+)/);
      if (m) port = parseInt(m[1], 10);
      else if (fileEnv.PORT) port = parseInt(fileEnv.PORT, 10);
      else if (process.env.PORT) port = parseInt(process.env.PORT, 10);
    } catch {}

    try {
      const { register } = await import("./monitor");
      await register({
        prefix, name, pid: proc.pid,
        logFile: logPath, port, script,
        startedAt: new Date().toISOString(),
        cwd: dir,
      });
    } catch {}

    log.ok(`watching ${prefix}:${name} (pid=${proc.pid}) in background`);
    log.info(`  log:    mx logs ${prefix} ${name} -f`);
    log.info(`  list:   mx monitor ls`);
    log.info(`  stop:   mx stop ${prefix} ${name}`);
    return;
  }

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

    // Register in monitor registry
    const { register, unregister } = await import("./monitor");
    let port: number | undefined;
    try {
      const pkg = JSON.parse(await readFile(pathJoin(dir, "package.json"), "utf8"));
      const m = JSON.stringify(pkg.scripts ?? {}).match(/--port\s+(\d+)/);
      if (m) port = parseInt(m[1], 10);
      else if (fileEnv.PORT) port = parseInt(fileEnv.PORT, 10);
      else if (process.env.PORT) port = parseInt(process.env.PORT, 10);
    } catch {}
    await register({
      prefix,
      name,
      pid: proc.pid,
      logFile: logPath,
      port,
      script,
      startedAt: new Date().toISOString(),
      cwd: dir,
    });
    log.info(`registered in monitor (pid=${proc.pid}). Try: mx monitor ls`);
    process.on("SIGINT", async () => {
      await unregister(prefix, name);
      proc.kill();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await unregister(prefix, name);
      proc.kill();
      process.exit(0);
    });
  }
  const code = await proc.exited;
  if (opts.log) {
    const { unregister } = await import("./monitor");
    await unregister(prefix, name);
  }
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

  // --watch: detached background mode, return immediately
  if (opts.watch) {
    for (const t of targets) {
      const args = runArgs(pm, script);
      const fileEnv = await loadEnv(t.dir);
      log.info(`starting ${kindLabel(t.kind)}/${t.name} (watch): ${pm} ${args.join(" ")}`);
      await ensureLogsDir();
      const logPath = pathJoin(LOGS_DIR, `${t.prefix}-${t.name}.log`);
      const proc = spawnWatched([pm, ...args], t.dir, logPath, { ...mergeEnv(fileEnv), FORCE_COLOR: "1" });

      let port: number | undefined;
      try {
        const m = JSON.stringify(args).match(/--port\s+(\d+)/);
        if (m) port = parseInt(m[1], 10);
        else if (fileEnv.PORT) port = parseInt(fileEnv.PORT, 10);
        else if (process.env.PORT) port = parseInt(process.env.PORT, 10);
      } catch {}

      try {
        const { register } = await import("./monitor");
        await register({
          prefix: t.prefix, name: t.name, pid: proc.pid,
          logFile: logPath, port, script,
          startedAt: new Date().toISOString(),
          cwd: t.dir,
        });
      } catch {}
    }
    log.ok(`watching ${targets.length} app(s) in background`);
    log.info(`  list:   mx monitor ls`);
    log.info(`  tail:   mx monitor tail -f`);
    log.info(`  stop:   mx stop all`);
    return;
  }

  const procs = await Promise.all(
    targets.map(async (t) => {
      const args = runArgs(pm, script);
      const fileEnv = await loadEnv(t.dir);
      log.info(`starting ${kindLabel(t.kind)}/${t.name}: ${pm} ${args.join(" ")}`);
      if (opts.log) await ensureLogsDir();
      const proc = Bun.spawn([pm, ...args], {
        cwd: t.dir,
        stdio: ["inherit", "pipe", "pipe"],
        env: { ...mergeEnv(fileEnv), FORCE_COLOR: "1" },
      });
      // Always prefix output with [prefix:name] for clarity, color per app name
      const tag = appTag(t.prefix, t.name);

      let logWriter: ReturnType<typeof createWriteStream> | null = null;
      let logPath = "";
      if (opts.log) {
        await ensureLogsDir();
        logPath = pathJoin(LOGS_DIR, `${t.prefix}-${t.name}.log`);
        logWriter = createWriteStream(logPath, { flags: "a" });
      }
      const logTag = `[${t.prefix}:${t.name}]`;

      // Each stream gets ONE pump that handles terminal prefix + optional log write.
      pipeStream(proc.stdout, tag, logWriter, logTag);
      pipeStream(proc.stderr, tag, logWriter, logTag);

      // Register in monitor registry so `mx monitor ls/tail` knows about this app
      if (opts.log && logPath) {
        try {
          const { register } = await import("./monitor");
          let port: number | undefined;
          const m = JSON.stringify(args).match(/--port\s+(\d+)/);
          if (m) port = parseInt(m[1], 10);
          else if (fileEnv.PORT) port = parseInt(fileEnv.PORT, 10);
          else if (process.env.PORT) port = parseInt(process.env.PORT, 10);
          await register({
            prefix: t.prefix,
            name: t.name,
            pid: proc.pid,
            logFile: logPath,
            port,
            script,
            startedAt: new Date().toISOString(),
            cwd: t.dir,
          });
        } catch (e: any) {
          log.warn(`could not register ${t.prefix}:${t.name} in monitor: ${e.message}`);
        }
      }

      return { ...t, proc, logPath };
    })
  );

  // Cleanup registry on parent exit
  if (opts.log) {
    const cleanup = async () => {
      const { unregister } = await import("./monitor");
      for (const p of procs) {
        try { await unregister(p.prefix, p.name); } catch {}
      }
    };
    process.on("SIGINT", () => { cleanup().finally(() => process.exit(0)); });
    process.on("SIGTERM", () => { cleanup().finally(() => process.exit(0)); });
  }

  const codes = await Promise.all(procs.map((p) => p.proc.exited));

  // All processes exited — unregister all
  if (opts.log) {
    try {
      const { unregister } = await import("./monitor");
      for (const p of procs) {
        await unregister(p.prefix, p.name);
      }
    } catch {}
  }

  const failed = procs.filter((_, i) => codes[i] !== 0);

  if (failed.length > 0) {
    log.err(`${failed.length} process(es) failed:`);
    for (const f of failed) log.err(`  - ${kindLabel(f.kind)}/${f.name} (exit ${codes[procs.indexOf(f)]})`);
    process.exit(1);
  }
  log.ok("All apps finished cleanly.");
}

/**
 * Stream reader: line-buffer child stdout/stderr.
 * - Each complete line gets `tag` prefix when written to terminal.
 * - If `logWriter` is provided, raw bytes (with logTag + timestamp) are also written there.
 * - Preserves ANSI escape codes from child process.
 */
function pipeStream(
  src: ReadableStream<Uint8Array> | undefined,
  tag: string,
  logWriter: ReturnType<typeof createWriteStream> | null,
  logTag: string,
) {
  if (!src) return;
  const decoder = new TextDecoder();
  const reader = src.getReader();
  let buffer = "";
  const flushLine = (line: string) => {
    if (line.length === 0) {
      process.stdout.write(`${tag} \n`);
    } else {
      process.stdout.write(`${tag} ${line}\n`);
    }
  };
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.length > 0) {
            flushLine(buffer);
            if (logWriter) logWriter.write(`${new Date().toISOString()} ${logTag} ${buffer}\n`);
            buffer = "";
          }
          break;
        }
        if (!value) continue;
        const text = decoder.decode(value, { stream: true });
        if (logWriter) logWriter.write(`${new Date().toISOString()} ${logTag} ${text}`);
        buffer += text;
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          flushLine(line);
        }
      }
    } catch {}
  })();
}

/**
 * Spawn a child process in detached mode (--watch).
 * - stdout/stderr go to log file only (terminal not streamed)
 * - process keeps running after parent CLI exits
 * - returns the spawned proc for monitoring/unref
 */
function spawnWatched(argv: string[], cwd: string, logPath: string, env: NodeJS.ProcessEnv) {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const out = require("node:fs").openSync(logPath, "a");
  const err = require("node:fs").openSync(logPath, "a");
  const proc = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  proc.unref();
  return proc as unknown as { pid: number };
}
