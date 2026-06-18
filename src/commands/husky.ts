import { exists, log, pathJoin, ROOT, AppKind, KIND_DIR, KIND_APPS_DIR, PackageManager, isValidPm, detectPkgManager, writeFile } from "../utils";
import { readFile } from "node:fs/promises";

export async function setupHusky() {
  log.step("Setting up husky + lint-staged...");

  const rootPkgPath = pathJoin(ROOT, "package.json");
  if (!exists(rootPkgPath)) {
    log.err("run `mx init` first");
    process.exit(1);
  }

  const rootPkg = JSON.parse(await readFile(rootPkgPath, "utf8"));
  rootPkg.devDependencies = {
    ...(rootPkg.devDependencies ?? {}),
    husky: "^9.1.0",
    "lint-staged": "^15.2.0",
  };
  rootPkg.scripts = {
    ...(rootPkg.scripts ?? {}),
    prepare: "husky",
  };
  rootPkg["lint-staged"] = {
    "*.{ts,tsx,js,jsx,json,md}": ["prettier --write"],
  };
  await writeFile(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n", "utf8");
  log.ok("updated root package.json (husky, lint-staged, prepare script)");

  // Install
  const pm = await loadPm();
  log.info(`installing husky via ${pm}...`);
  const installCode = await Bun.spawn([pm, "install"], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
  if (installCode !== 0) {
    log.err("install failed");
    process.exit(1);
  }

  // Init husky
  await Bun.spawn([pm, "exec", "husky", "init"], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;

  // Add pre-commit hook
  const preCommitPath = pathJoin(ROOT, ".husky", "pre-commit");
  if (exists(preCommitPath)) {
    await writeFile(preCommitPath, "npx lint-staged\n", "utf8");
    log.ok("configured .husky/pre-commit (lint-staged)");
  }

  log.ok("husky ready. Edit .husky/pre-commit to add more hooks.");
  log.info("Try: git init && git add . && git commit -m 'init'");
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
