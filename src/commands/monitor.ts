import { exists, log, pathJoin, ROOT, c, colorFor, AppKind, KIND_APPS_DIR, KIND_DIR, writeFile } from "../utils";
import { readFile, readdir, stat } from "node:fs/promises";

const REGISTRY_PATH = pathJoin(ROOT, ".mx/monitor.json");

export interface MonitorEntry {
  prefix: "be" | "fe";
  name: string;
  pid: number;
  logFile: string;
  port?: number;
  script: string;
  startedAt: string;
  cwd: string;
}

export interface DiscoveredApp {
  prefix: "be" | "fe";
  name: string;
  kind: "app" | "pkg";
  port?: number;
  state: "running" | "stopped" | "unreachable";
  pid?: number;
  procName?: string;
  source: "mx-run" | "external" | "tracked-dead";
}

interface Registry {
  entries: MonitorEntry[];
}

async function loadRegistry(): Promise<Registry> {
  if (!exists(REGISTRY_PATH)) return { entries: [] };
  try {
    return JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
  } catch {
    return { entries: [] };
  }
}

async function saveRegistry(reg: Registry): Promise<void> {
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

// Serializes registry mutations to prevent lost writes when multiple processes
// (e.g. parallel `mx run all` targets) call register/unregister at once.
let registryChain: Promise<void> = Promise.resolve();
function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = registryChain.then(fn, fn);
  registryChain = result.then(() => undefined, () => undefined);
  return result;
}

export async function register(entry: MonitorEntry): Promise<void> {
  await withRegistryLock(async () => {
    const reg = await loadRegistry();
    reg.entries = reg.entries.filter((e) => !(e.prefix === entry.prefix && e.name === entry.name));
    reg.entries.push(entry);
    await saveRegistry(reg);
  });
}

export async function unregister(prefix: "be" | "fe", name: string): Promise<void> {
  await withRegistryLock(async () => {
    const reg = await loadRegistry();
    reg.entries = reg.entries.filter((e) => !(e.prefix === prefix && e.name === name));
    await saveRegistry(reg);
  });
}

export async function isAlive(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const out = (await new Response(proc.stdout).text()).trim();
      return out.toLowerCase().includes("node") || out.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

export async function listTracked(): Promise<{ entry: MonitorEntry; alive: boolean }[]> {
  const reg = await loadRegistry();
  const out: { entry: MonitorEntry; alive: boolean }[] = [];
  for (const e of reg.entries) {
    out.push({ entry: e, alive: await isAlive(e.pid) });
  }
  return out;
}

// ===== Discovery: combine registry + port-probing across known apps =====

async function listKnownApps(): Promise<{ prefix: "be" | "fe"; kind: "app" | "pkg"; name: string; dir: string; port?: number }[]> {
  const out: { prefix: "be" | "fe"; kind: "app" | "pkg"; name: string; dir: string; port?: number }[] = [];
  for (const prefix of ["be", "fe"] as const) {
    const kindRoot: AppKind = prefix === "be" ? "backend" : "frontend";
    const appsBase = pathJoin(ROOT, KIND_APPS_DIR[kindRoot]);
    if (exists(appsBase)) {
      for (const d of await readdir(appsBase, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = pathJoin(appsBase, d.name);
        const port = await detectPort(dir);
        if (port) out.push({ prefix, kind: "app", name: d.name, dir, port });
      }
    }
  }
  return out;
}

async function detectPort(appDir: string): Promise<number | undefined> {
  const pkgPath = pathJoin(appDir, "package.json");
  if (!exists(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const m = JSON.stringify(pkg.scripts ?? {}).match(/--port\s+(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch {}
  // Fallback: check .env / .env.example for PORT=
  for (const f of [".env", ".env.example", ".env.local"]) {
    const envPath = pathJoin(appDir, f);
    if (!exists(envPath)) continue;
    try {
      const raw = await readFile(envPath, "utf8");
      const m = raw.match(/^\s*PORT\s*=\s*(\d+)/m);
      if (m) return parseInt(m[1], 10);
    } catch {}
  }
  return undefined;
}

async function probePort(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status > 0; // any HTTP response = port in use
  } catch {
    return false;
  }
}

async function portListening(port: number): Promise<boolean> {
  // Quick check via netstat (avoids HTTP timeout penalty)
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["netstat", "-ano"], { stdio: ["ignore", "pipe", "ignore"] });
      const out = await new Response(proc.stdout).text();
      // Lines like: TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    1234
      return out.split(/\r?\n/).some((line) => line.includes(`:${port}`) && line.includes("LISTENING"));
    } else {
      const proc = Bun.spawn(["bash", "-c", `ss -ltn 2>/dev/null | grep -q ":${port} " || netstat -ltn 2>/dev/null | grep -q ":${port} "`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      return (await proc.exited) === 0;
    }
  } catch {
    return false;
  }
}

async function findPidOnPort(port: number): Promise<{ pid: number; name: string } | undefined> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["netstat", "-ano"], { stdio: ["ignore", "pipe", "ignore"] });
      const out = await new Response(proc.stdout).text();
      const lines = out.split(/\r?\n/).filter((l) => l.includes(`:${port}`) && l.includes("LISTENING"));
      for (const line of lines) {
        const m = line.trim().split(/\s+/).pop();
        if (m && /^\d+$/.test(m)) {
          const pid = parseInt(m, 10);
          const name = await procName(pid);
          return { pid, name };
        }
      }
    } else {
      const proc = Bun.spawn(["bash", "-c", `lsof -iTCP:${port} -sTCP:LISTEN -nP 2>/dev/null | tail -1`], { stdio: ["ignore", "pipe", "ignore"] });
      const out = (await new Response(proc.stdout).text()).trim();
      const m = out.match(/\s(\d+)\s/);
      if (m) return { pid: parseInt(m[1], 10), name: await procName(parseInt(m[1], 10)) };
    }
  } catch {}
  return undefined;
}

async function procName(pid: number): Promise<string> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const out = (await new Response(proc.stdout).text()).trim();
      const m = out.match(/^"([^"]+)"/);
      return m ? m[1] : "?";
    } else {
      const proc = Bun.spawn(["bash", "-c", `cat /proc/${pid}/comm 2>/dev/null`], { stdio: ["ignore", "pipe", "ignore"] });
      const out = (await new Response(proc.stdout).text()).trim();
      return out || "?";
    }
  } catch {
    return "?";
  }
}

export async function discoverAllApps(): Promise<DiscoveredApp[]> {
  const tracked = await listTracked();
  const aliveTracked = new Map<string, MonitorEntry>();
  for (const { entry, alive } of tracked) {
    if (alive) aliveTracked.set(`${entry.prefix}:${entry.name}`, entry);
  }

  // Clean dead tracked entries
  if (aliveTracked.size !== tracked.length) {
    await withRegistryLock(async () => {
      const reg = await loadRegistry();
      reg.entries = reg.entries.filter((e) => aliveTracked.has(`${e.prefix}:${e.name}`));
      await saveRegistry(reg);
    });
  }

  const knownApps = await listKnownApps();
  const results: DiscoveredApp[] = [];

  // Probe all known ports in parallel
  const probes = await Promise.all(
    knownApps.map(async (a) => {
      const listening = a.port ? await portListening(a.port) : false;
      const pidInfo = listening && a.port ? await findPidOnPort(a.port) : undefined;
      return { app: a, listening, pidInfo };
    })
  );

  for (const { app, listening, pidInfo } of probes) {
    const trackedKey = `${app.prefix}:${app.name}`;
    const trackedEntry = aliveTracked.get(trackedKey);
    if (trackedEntry) {
      results.push({
        prefix: app.prefix,
        name: app.name,
        kind: "app",
        port: app.port,
        state: "running",
        pid: trackedEntry.pid,
        source: "mx-run",
      });
    } else if (listening) {
      results.push({
        prefix: app.prefix,
        name: app.name,
        kind: "app",
        port: app.port,
        state: "running",
        pid: pidInfo?.pid,
        procName: pidInfo?.name,
        source: "external",
      });
    }
  }
  return results;
}

// === Subcommands ===

export async function monitorLs() {
  log.step("Monitored processes");
  const apps = await discoverAllApps();

  // Clean dead tracked entries
  const tracked = await listTracked();
  const aliveTracked = tracked.filter((t) => t.alive);

  // Also surface tracked apps without port detection (so logs/PS still work)
  const trackedOnly = aliveTracked.filter(
    (t) => !apps.find((a) => a.prefix === t.entry.prefix && a.name === t.entry.name)
  );

  if (apps.length === 0 && trackedOnly.length === 0) {
    log.info("no processes running in this monorepo");
    log.info("start one with: mx run <be|fe> <name> dev --log");
    return;
  }

  console.log();
  console.log(
    `  ${c.dim}${"kind".padEnd(5)} ${"name".padEnd(20)} ${"source".padEnd(10)} ${"pid".padEnd(8)} ${"port".padEnd(6)} ${"state".padEnd(11)} ${"uptime".padEnd(10)} script${c.reset}`
  );

  for (const a of apps) {
    const trackedEntry = aliveTracked.find((t) => t.entry.prefix === a.prefix && t.entry.name === a.name)?.entry;
    const uptime = trackedEntry ? fmtUptime(Date.now() - new Date(trackedEntry.startedAt).getTime()) : `${c.dim}-${c.reset}`;
    const kindTag = a.prefix === "be" ? `${c.dim}BE${c.reset}` : `${c.dim}FE${c.reset}`;
    const nameColored = `${colorFor(a.name)}${c.bold}${a.name.padEnd(20)}${c.reset}`;
    const sourceTag = a.source === "mx-run" ? `${c.green}mx-run${c.reset}` : `${c.yellow}external${c.reset}`;
    const stateTag = a.state === "running" ? `${c.green}running${c.reset}` : `${c.red}${a.state}${c.reset}`;
    const portStr = a.port ? String(a.port) : `${c.dim}-${c.reset}`;
    const pidStr = a.pid ? String(a.pid) : `${c.dim}-${c.reset}`;
    const script = trackedEntry?.script ?? (a.procName ?? `${c.dim}-${c.reset}`);
    console.log(
      `  ${kindTag}   ${nameColored} ${sourceTag.padEnd(10 + 9)} ${pidStr.padEnd(8)} ${portStr.padEnd(6 + 9)} ${stateTag.padEnd(11 + 9)} ${uptime.padEnd(10)} ${script}`
    );
  }

  // Tracked without port
  for (const { entry } of trackedOnly) {
    const kindTag = entry.prefix === "be" ? `${c.dim}BE${c.reset}` : `${c.dim}FE${c.reset}`;
    const nameColored = `${colorFor(entry.name)}${c.bold}${entry.name.padEnd(20)}${c.reset}`;
    const portStr = entry.port ? String(entry.port) : `${c.dim}-${c.reset}`;
    const uptime = fmtUptime(Date.now() - new Date(entry.startedAt).getTime());
    console.log(
      `  ${kindTag}   ${nameColored} ${c.green}mx-run${c.reset.padEnd(10 + 9)} ${String(entry.pid).padEnd(8)} ${portStr.padEnd(6 + 9)} ${c.dim}no-port${c.reset.padEnd(11 + 9)} ${uptime.padEnd(10)} ${entry.script}`
    );
  }
  console.log();
  log.info(`kill with: mx stop <be|fe> <name>  OR  mx stop <pid>  OR  mx stop all`);
}

export async function monitorPs() {
  const apps = await discoverAllApps();
  if (apps.length === 0) {
    log.info("no running apps");
    return;
  }
  log.step(`Process info for ${apps.length} app(s)`);
  console.log();
  for (const a of apps) {
    if (!a.pid) continue;
    const info = await procInfo(a.pid);
    console.log(`  ${c.bold}${a.prefix}:${a.name}${c.reset}  pid=${a.pid}  [${a.source}]`);
    if (info) {
      console.log(`    CPU:   ${info.cpu}`);
      console.log(`    MEM:   ${info.mem}`);
      if (info.uptimeMs > 0) console.log(`    uptime: ${fmtUptime(info.uptimeMs)}`);
    }
  }
  console.log();
}

async function procInfo(pid: number): Promise<{ cpu: string; mem: string; uptimeMs: number } | null> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(
        [
          "powershell",
          "-NoProfile",
          "-Command",
          `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object @{Name='CPU';Expression={[math]::Round($_.CPU,2)}}, @{Name='WS_MB';Expression={[math]::Round($_.WorkingSet64/1MB,1)}}, @{Name='StartTime';Expression={$_.StartTime}} | ConvertTo-Json -Compress`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      const out = (await new Response(proc.stdout).text()).trim();
      if (!out) return null;
      const data = JSON.parse(out) as { CPU: number; WS_MB: number; StartTime: string };
      const startMs = new Date(data.StartTime).getTime();
      return {
        cpu: `${data.CPU}s`,
        mem: `${data.WS_MB} MB`,
        uptimeMs: isNaN(startMs) ? 0 : Date.now() - startMs,
      };
    } else {
      const proc = Bun.spawn(["ps", "-o", "pid=,pcpu=,rss=,etime=", "-p", String(pid)], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const out = (await new Response(proc.stdout).text()).trim();
      if (!out) return null;
      const parts = out.split(/\s+/);
      const rssMb = (parseInt(parts[2], 10) / 1024).toFixed(1);
      const etime = parts[3];
      return { cpu: `${parts[1]}%`, mem: `${rssMb} MB`, uptimeMs: etimeToMs(etime) };
    }
  } catch {
    return null;
  }
}

function etimeToMs(etime: string): number {
  let days = 0;
  let rest = etime;
  if (rest.includes("-")) {
    const parts = rest.split("-");
    days = parseInt(parts[0] ?? "0", 10);
    rest = parts[1] ?? "";
  }
  const parts = rest.split(":").map(Number);
  let s = 0;
  if (parts.length === 3) s = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  else if (parts.length === 2) s = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return (s + days * 86400) * 1000;
}

export async function monitorHealth() {
  const apps = await discoverAllApps();
  const targets = apps.filter((a) => a.port);
  if (targets.length === 0) {
    log.info("no apps with known ports");
    return;
  }
  log.step(`Health check for ${targets.length} app(s)`);
  console.log();
  await Promise.all(targets.map(async (a) => {
    const url = `http://localhost:${a.port}/health`;
    const start = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const ms = Date.now() - start;
      const ok = res.ok;
      const icon = ok ? `${c.green}\u2713${c.reset}` : `${c.red}\u2717${c.reset}`;
      const status = ok ? `${c.green}${res.status}${c.reset}` : `${c.red}${res.status}${c.reset}`;
      const sourceTag = a.source === "mx-run" ? c.green : c.yellow;
      console.log(`  ${icon} ${a.prefix}:${a.name.padEnd(20)} ${status}  ${String(ms).padStart(4)}ms  ${c.dim}${url}${c.reset}  ${sourceTag}[${a.source}]${c.reset}`);
      if (ok) {
        try {
          const body = await res.json() as any;
          if (body?.status) console.log(`     ${c.dim}body: status=${body.status}${c.reset}`);
        } catch {}
      }
    } catch {
      const ms = Date.now() - start;
      console.log(`  ${c.red}?${c.reset} ${a.prefix}:${a.name.padEnd(20)} ${c.red}unreachable${c.reset}  ${String(ms).padStart(4)}ms  ${c.dim}${url}${c.reset}  ${c.yellow}[${a.source}]${c.reset}`);
    }
  }));
  console.log();
}

export async function monitorTail(opts: { follow?: boolean; lines?: number } = {}) {
  const lines = opts.lines ?? 30;

  // Sources of log entries to show:
  //  1. Tracked entries (registered via `mx run --log`)
  //  2. Any *.log file under .mx/logs/ that isn't already in tracked list (orphans)
  const tracked = await listTracked();
  const aliveTracked = tracked.filter((t) => t.alive);
  const trackedLogFiles = new Set(aliveTracked.map((t) => t.entry.logFile));

  type TailTarget = { label: string; logFile: string };
  const targets: TailTarget[] = [];
  for (const { entry } of aliveTracked) {
    targets.push({ label: `${entry.prefix}:${entry.name}`, logFile: entry.logFile });
  }

  // Discover orphan log files (e.g. from previous `mx run --log` whose parent exited)
  const LOGS_DIR = pathJoin(ROOT, ".mx/logs");
  if (exists(LOGS_DIR)) {
    const files = (await readdir(LOGS_DIR)).filter((f) => f.endsWith(".log"));
    for (const f of files) {
      const p = pathJoin(LOGS_DIR, f);
      if (trackedLogFiles.has(p)) continue;
      // Parse "<prefix>-<name>.log" → label
      const m = f.match(/^(be|fe)-(.+)\.log$/);
      const label = m ? `${m[1]}:${m[2]}` : f;
      targets.push({ label, logFile: p });
    }
  }

  if (targets.length === 0) {
    log.info("no log files in .mx/logs/ yet");
    log.info("start an app with: mx run <be|fe> <name> <script> --log");
    return;
  }

  console.log();
  for (const t of targets) {
    if (!exists(t.logFile)) continue;
    try {
      const content = await readFile(t.logFile, "utf8");
      const all = content.split(/\r?\n/);
      const last = all.slice(-lines).join("\n");
      console.log(`${c.dim}\u2500\u2500 ${t.label} (${t.logFile}) \u2500\u2500${c.reset}`);
      console.log(last || `${c.dim}(empty)${c.reset}`);
      const s = await stat(t.logFile);
      console.log(`${c.dim}(${(s.size / 1024).toFixed(1)} KB)${c.reset}`);
    } catch (e: any) {
      console.log(`  ${c.red}error reading ${t.logFile}: ${e.message}${c.reset}`);
    }
  }

  if (opts.follow) {
    console.log(`\n${c.dim}following ${targets.length} log file(s) - Ctrl+C to exit${c.reset}`);
    const procs = targets.map((t) => {
      const args =
        process.platform === "win32"
          ? ["powershell", "-NoProfile", "-Command", `Get-Content '${t.logFile}' -Wait -Tail ${lines}`]
          : ["tail", "-n", String(lines), "-f", t.logFile];
      return Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
    });
    await Promise.race(procs.map((p) => p.exited));
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
  }
}

export async function monitorLogsList() {
  const LOGS_DIR = pathJoin(ROOT, ".mx/logs");
  if (!exists(LOGS_DIR)) {
    log.info(`no logs yet in ${LOGS_DIR}`);
    return;
  }
  const files = (await readdir(LOGS_DIR)).filter((f) => f.endsWith(".log"));
  if (files.length === 0) {
    log.info("no logs yet");
    return;
  }
  log.step(`${files.length} log file(s):`);
  for (const f of files.sort()) {
    const p = pathJoin(LOGS_DIR, f);
    const s = await stat(p);
    console.log(`  ${f.padEnd(40)} ${(s.size / 1024).toFixed(1).padStart(8)} KB  ${s.mtime.toISOString()}`);
  }
}

export async function monitorStop(target: string, name?: string, opts: { all?: boolean; force?: boolean } = {}) {
  // Forms:
  //   mx monitor stop all [--force]                       → kill every discovered app
  //   mx monitor stop --all [--force]                     → same
  //   mx monitor stop <be|fe> <name>                      → kill by name (tracked or external)
  //   mx monitor stop <pid>                               → kill by pid

  const isAll = target === "all" || opts.all === true;

  if (isAll) {
    return stopAll(opts.force ?? false);
  }

  if (name !== undefined) {
    const prefix = target as "be" | "fe";
    if (prefix !== "be" && prefix !== "fe") {
      log.err("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    // Try tracked first
    const tracked = await listTracked();
    const found = tracked.find((t) => t.entry.prefix === prefix && t.entry.name === name);
    if (found?.alive) {
      await killPid(found.entry.pid, `${prefix}:${name}`);
      await unregister(prefix, name);
      return;
    }
    // Try discovery (external): probe known port
    const apps = await discoverAllApps();
    const discovered = apps.find((a) => a.prefix === prefix && a.name === name);
    if (!discovered) {
      log.err(`not found: ${prefix}:${name}`);
      process.exit(1);
    }
    if (!discovered.pid) {
      log.err(`${prefix}:${name} has no detectable PID (try stopping manually)`);
      process.exit(1);
    }
    await killPid(discovered.pid, `${prefix}:${name} (external)`);
    return;
  }
  // PID form
  const pid = parseInt(target, 10);
  if (isNaN(pid)) {
    log.err("usage: mx monitor stop <be|fe> <name>  OR  mx monitor stop <pid>  OR  mx monitor stop all");
    process.exit(1);
  }
  if (!(await isAlive(pid))) {
    log.warn(`pid ${pid} not running`);
    return;
  }
  await killPid(pid, `pid ${pid}`);
}

async function stopAll(force: boolean) {
  const apps = await discoverAllApps();
  // Also include tracked entries without port (so we can stop them too)
  const tracked = await listTracked();
  const aliveTracked = tracked.filter((t) => t.alive);
  const trackedWithoutPort = aliveTracked.filter(
    (t) => !apps.find((a) => a.prefix === t.entry.prefix && a.name === t.entry.name)
  );

  const totalTargets = apps.length + trackedWithoutPort.length;
  if (totalTargets === 0) {
    log.info("no apps running");
    return;
  }

  // Confirmation prompt (TTY only)
  if (!force && process.stdin.isTTY) {
    console.log();
    log.warn(`about to stop ${totalTargets} app(s):`);
    for (const a of apps) {
      console.log(`  - ${a.prefix}:${a.name}  pid=${a.pid ?? "?"}  port=${a.port ?? "-"}  [${a.source}]`);
    }
    for (const { entry } of trackedWithoutPort) {
      console.log(`  - ${entry.prefix}:${entry.name}  pid=${entry.pid}  [mx-run, no port]`);
    }
    console.log();
    const ok = await confirmYesNo("Continue? [y/N] ");
    if (!ok) {
      log.info("aborted.");
      return;
    }
  } else {
    log.step(`stopping ${totalTargets} app(s)...`);
  }

  let stopped = 0;
  let failed = 0;

  for (const a of apps) {
    if (!a.pid) {
      log.warn(`skip ${a.prefix}:${a.name} (no pid detected)`);
      continue;
    }
    try {
      await killPid(a.pid, `${a.prefix}:${a.name} [${a.source}]`);
      stopped++;
    } catch {
      failed++;
    }
  }

  for (const { entry } of trackedWithoutPort) {
    try {
      await killPid(entry.pid, `${entry.prefix}:${entry.name} [mx-run]`);
      await unregister(entry.prefix, entry.name);
      stopped++;
    } catch {
      failed++;
    }
  }

  // Clean any remaining dead tracked entries
  const remaining = await listTracked();
  const deadIds = remaining.filter((r) => !r.alive).map((r) => `${r.entry.prefix}:${r.entry.name}`);
  if (deadIds.length > 0) {
    await withRegistryLock(async () => {
      const reg = await loadRegistry();
      reg.entries = reg.entries.filter((e) => !deadIds.includes(`${e.prefix}:${e.name}`));
      await saveRegistry(reg);
    });
  }

  console.log();
  log.ok(`stopped ${stopped} app(s)` + (failed > 0 ? `, ${failed} failed` : ""));
}

function confirmYesNo(question: string): Promise<boolean> {
  const stdout = process.stdout;
  const stdin = process.stdin;
  stdout.write(`\x1b[33m?\x1b[0m ${question}`);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.includes("\n") || input.includes("\r")) {
        stdin.removeListener("data", onData);
        stdin.pause();
        const c = input.trim().toLowerCase();
        resolve(c === "y" || c === "yes");
      }
    };
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function killPid(pid: number, label: string) {
  log.info(`stopping ${label} (pid ${pid})...`);
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      await proc.exited;
    } else {
      process.kill(pid, "SIGTERM");
    }
    log.ok(`stopped: ${label}`);
  } catch (e: any) {
    log.err(`failed to stop: ${e.message}`);
    process.exit(1);
  }
}

function fmtUptime(ms: number): string {
  if (ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
