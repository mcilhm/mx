import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR } from "../utils";
import { readdir, readFile } from "node:fs/promises";

export async function format() {
  log.step("Formatting all apps...");
  const procs: Promise<number>[] = [];

  for (const kind of ["backend", "frontend"] as AppKind[]) {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(base)) continue;
    for (const d of await readdir(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = pathJoin(base, d.name);
      const pkgPath = pathJoin(dir, "package.json");
      if (!exists(pkgPath)) continue;

      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      const scripts = pkg.scripts ?? {};

      let cmd: string[] | null = null;
      if (scripts.format) {
        cmd = [scripts.format];
      } else if (exists(pathJoin(dir, "biome.json")) || exists(pathJoin(dir, "biome.jsonc"))) {
        cmd = ["biome", "format", "--write", "."];
      } else {
        cmd = ["prettier", "--write", "."];
      }

      log.info(`formatting ${kind}/${d.name}: ${cmd.join(" ")}`);
      procs.push(runFormat(cmd, dir));
    }
  }

  if (procs.length === 0) {
    log.warn("no apps to format");
    return;
  }
  const codes = await Promise.all(procs);
  if (codes.some((c) => c !== 0)) {
    log.err("some apps failed to format");
    process.exit(1);
  }
  log.ok("all apps formatted");
}

function runFormat(cmd: string[], cwd: string): Promise<number> {
  return Bun.spawn(cmd, {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
}
