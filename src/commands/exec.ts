import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, PackageManager, detectPkgManager, isValidPm, pmRunArgs } from "../utils";
import { readFile } from "node:fs/promises";

export async function execInApp(prefix: "be" | "fe", name: string, cmdParts: string[]) {
  if (cmdParts.length === 0) {
    log.err("usage: mx exec <be|fe> <name> -- <command...>");
    process.exit(1);
  }
  const kind: AppKind = prefix === "be" ? "backend" : "frontend";
  const dir = pathJoin(ROOT, KIND_APPS_DIR[kind], name);
  if (!exists(dir)) {
    log.err(`App not found: ${dir}`);
    process.exit(1);
  }
  if (!exists(pathJoin(dir, "package.json"))) {
    log.err(`No package.json in ${dir}`);
    process.exit(1);
  }

  const pm = await loadPm();
  // If cmd starts with "script" and exists in package.json, prefix with pm run
  const [first, ...rest] = cmdParts;
  const pkg = JSON.parse(await readFile(pathJoin(dir, "package.json"), "utf8"));
  let argv: string[];
  if (pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, first)) {
    argv = [pm, ...pmRunArgs(pm as PackageManager, first), ...rest];
  } else {
    argv = [first, ...rest];
  }

  log.info(`$ ${argv.join(" ")}  (in ${KIND_APPS_DIR[kind]}/${name})`);
  // On Windows, resolve shell builtins (echo, dir, etc.) via cmd /c
  const isWin = process.platform === "win32";
  const needsShell = isWin && !/^[a-zA-Z]:[\\/]/.test(argv[0]) && !argv[0].startsWith("/");
  const finalArgv = needsShell ? [isWin ? "cmd" : "sh", isWin ? "/c" : "-c", argv.join(" ")] : argv;
  const proc = Bun.spawn(finalArgv, {
    cwd: dir,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  process.exit(await proc.exited);
}

async function loadPm(): Promise<string> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (isValidPm(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return detectPkgManager();
}
