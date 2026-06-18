import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, PackageManager, ensureDir, loadPm } from "../utils";
import { readFile } from "node:fs/promises";

export async function shell(prefix: "be" | "fe", name: string) {
  const kind: AppKind = prefix === "be" ? "backend" : "frontend";
  const dir = pathJoin(ROOT, KIND_APPS_DIR[kind], name);
  if (!exists(dir)) {
    log.err(`App not found: ${dir}`);
    process.exit(1);
  }
  const pm = await loadPm();

  log.info(`opening shell in ${KIND_APPS_DIR[kind]}/${name} (${pm} available, type 'exit' to leave)`);

  const shellCmd = process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "bash");
  const isWin = process.platform === "win32";
  const argv = isWin ? ["cmd.exe", "/k"] : [shellCmd];

  const proc = Bun.spawn(argv, {
    cwd: dir,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: "1", PS1: `mx ${prefix}:${name} $ ` },
  });
  process.exit(await proc.exited);
}
