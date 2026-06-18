import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR } from "../utils";
import { readFile, writeFile, rename, readdir } from "node:fs/promises";

export async function renameApp(prefix: "be" | "fe", oldName: string, newName: string) {
  if (oldName === newName) {
    log.warn("old and new names are identical");
    return;
  }
  const kind: AppKind = prefix === "be" ? "backend" : "frontend";
  const oldDir = pathJoin(ROOT, KIND_APPS_DIR[kind], oldName);
  const newDir = pathJoin(ROOT, KIND_APPS_DIR[kind], newName);

  if (!exists(oldDir)) {
    log.err(`App not found: ${oldDir}`);
    process.exit(1);
  }
  if (exists(newDir)) {
    log.err(`Target already exists: ${newDir}`);
    process.exit(1);
  }

  // Detect port if used
  const pkgPath = pathJoin(oldDir, "package.json");
  let usedPort: number | undefined;
  if (exists(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const m = JSON.stringify(pkg.scripts ?? {}).match(/--port\s+(\d+)/);
    if (m) usedPort = parseInt(m[1], 10);
    // Rename package name
    const oldPkgName = pkg.name;
    const newPkgName = `${prefix === "be" ? "be" : "fe"}-${newName}`;
    pkg.name = newPkgName;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    log.ok(`renamed package: ${oldPkgName} -> ${newPkgName}`);
  }

  await rename(oldDir, newDir);
  log.ok(`moved: ${KIND_APPS_DIR[kind]}/${oldName} -> ${newName}`);

  // For frontend, assign next free port
  if (kind === "frontend" && !usedPort) {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    const used = new Set<number>();
    for (const d of await readdir(base, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === newName) continue;
      const pp = pathJoin(base, d.name, "package.json");
      if (!exists(pp)) continue;
      try {
        const p = JSON.parse(await readFile(pp, "utf8"));
        const m = JSON.stringify(p.scripts ?? {}).match(/--port\s+(\d+)/);
        if (m) used.add(parseInt(m[1], 10));
      } catch {}
    }
    let port = 3000;
    while (used.has(port)) port++;
    usedPort = port;
  }

  // Re-link workspace
  const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
  if (exists(pathJoin(rootDir, "package.json"))) {
    log.info("re-linking workspace...");
    const pm = await loadPm();
    await Bun.spawn([pm, "install"], {
      cwd: rootDir,
      stdio: ["inherit", "inherit", "inherit"],
    }).exited;
  }
}

async function loadPm(): Promise<string> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (["bun", "pnpm", "yarn", "npm"].includes(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return "bun";
}
