import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, PackageManager, isValidPm, detectPkgManager, pmRunArgs } from "../utils";
import { readdir, readFile } from "node:fs/promises";

export async function typecheck() {
  log.step("Typechecking all apps in parallel...");
  const targets: { kind: AppKind; name: string; dir: string }[] = [];

  for (const kind of ["backend", "frontend"] as AppKind[]) {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(base)) continue;
    for (const d of await readdir(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = pathJoin(base, d.name);
      if (!exists(pathJoin(dir, "tsconfig.json")) && !exists(pathJoin(dir, "package.json"))) continue;
      targets.push({ kind, name: d.name, dir });
    }
  }

  if (targets.length === 0) {
    log.warn("no apps to typecheck");
    return;
  }

  const pm = await loadPm();
  const procs = targets.map(async (t) => {
    const pkgPath = pathJoin(t.dir, "package.json");
    let scriptName: string;
    if (exists(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      const scripts = pkg.scripts ?? {};
      scriptName = scripts.typecheck ? "typecheck" : (scripts["type-check"] ?? "");
    } else {
      scriptName = "";
    }

    let argv: string[];
    if (scriptName) {
      argv = [pm, ...pmRunArgs(pm, scriptName)];
    } else if (exists(pathJoin(t.dir, "tsconfig.json"))) {
      argv = ["tsc", "--noEmit"];
    } else {
      log.warn(`skipping ${t.kind}/${t.name}: no tsconfig or typecheck script`);
      return 0;
    }

    log.info(`checking ${t.kind}/${t.name}: ${argv.join(" ")}`);
    return Bun.spawn(argv, {
      cwd: t.dir,
      stdio: ["inherit", "inherit", "inherit"],
    }).exited;
  });

  const codes = await Promise.all(procs);
  if (codes.some((c) => c !== 0)) {
    log.err("typecheck failed in one or more apps");
    process.exit(1);
  }
  log.ok("all apps typecheck passed");
}

async function loadPm(): Promise<PackageManager> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (isValidPm(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return detectPkgManager();
}
