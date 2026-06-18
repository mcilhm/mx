import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR, PackageManager, isValidPm } from "../utils";
import { readFile, writeFile } from "node:fs/promises";

export async function linkPackage(prefix: "be" | "fe", appName: string, pkgName: string) {
  const kind: AppKind = prefix === "be" ? "backend" : "frontend";
  const appDir = pathJoin(ROOT, KIND_APPS_DIR[kind], appName);
  if (!exists(appDir)) {
    log.err(`App not found: ${appDir}`);
    process.exit(1);
  }

  // Resolve pkg name (allow short or full)
  const pkgShortName = pkgName.replace(/^(be|fe)-/, "");
  const fullName = `${prefix === "be" ? "be" : "fe"}-${pkgShortName}`;

  const pkgDir = pathJoin(ROOT, KIND_DIR[kind], "packages", pkgShortName);
  if (!exists(pathJoin(pkgDir, "package.json"))) {
    log.err(`Package not found: ${pkgDir}`);
    log.info(`Create it first: mx pkg:add ${prefix} ${pkgShortName}`);
    process.exit(1);
  }

  const appPkgPath = pathJoin(appDir, "package.json");
  const appPkg = JSON.parse(await readFile(appPkgPath, "utf8"));
  const deps = appPkg.dependencies ?? {};
  deps[fullName] = "workspace:*";
  appPkg.dependencies = deps;
  await writeFile(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n", "utf8");
  log.ok(`linked: ${fullName} -> ${KIND_APPS_DIR[kind]}/${appName}`);

  // Re-link workspace
  const pm = await loadPm();
  await Bun.spawn([pm, "install"], {
    cwd: pathJoin(ROOT, KIND_DIR[kind]),
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
}

async function loadPm(): Promise<string> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (isValidPm(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return "bun";
}
