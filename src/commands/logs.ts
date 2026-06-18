import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, ensureDir } from "../utils";
import { readFile, stat } from "node:fs/promises";

const LOGS_DIR = pathJoin(ROOT, ".mx/logs");

export async function tailLogs(prefix: "be" | "fe", name: string, opts: { lines?: number; follow?: boolean } = {}) {
  const logFile = pathJoin(LOGS_DIR, `${prefix}-${name}.log`);

  if (!exists(logFile)) {
    log.warn(`no log file: ${logFile}`);
    log.info(`start an app with logging first: mx run ${prefix} ${name} dev --log`);
    return;
  }

  if (opts.follow) {
    log.info(`tailing ${logFile} (Ctrl+C to exit)...`);
    const proc = Bun.spawn(
      process.platform === "win32"
        ? ["powershell", "-NoProfile", "-Command", `Get-Content '${logFile}' -Wait -Tail ${opts.lines ?? 50}`]
        : ["tail", `-n`, String(opts.lines ?? 50), `-f`, logFile],
      { stdio: ["inherit", "inherit", "inherit"] }
    );
    process.exit(await proc.exited);
  } else {
    // Print last N lines
    const lines = opts.lines ?? 50;
    const content = await readFile(logFile, "utf8");
    const all = content.split(/\r?\n/);
    const last = all.slice(-lines).join("\n");
    console.log(last);
    const s = await stat(logFile);
    log.info(`${logFile} (${(s.size / 1024).toFixed(1)} KB)`);
  }
}

export async function listLogs() {
  await ensureDir(LOGS_DIR);
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(LOGS_DIR)).filter((f) => f.endsWith(".log"));
  if (files.length === 0) {
    log.info(`no logs yet in ${LOGS_DIR}`);
    return;
  }
  log.step(`${files.length} log file(s):`);
  for (const f of files.sort()) {
    const p = pathJoin(LOGS_DIR, f);
    const s = await stat(p);
    console.log(`  ${f.padEnd(40)} ${(s.size / 1024).toFixed(1).padStart(8)} KB  ${s.mtime.toISOString()}`);
  }
}

export function getLogFilePath(prefix: "be" | "fe", name: string): string {
  return pathJoin(LOGS_DIR, `${prefix}-${name}.log`);
}
