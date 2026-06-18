import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR, PackageManager, loadPm, ensureDir } from "../utils";
import { readdir, rm, stat } from "node:fs/promises";

const CLEAN_DIRS = ["node_modules", "dist", ".next", ".turbo", "out", "build", "coverage"];

interface Target {
  label: string;
  dir: string;
  paths: string[]; // relative paths to remove within dir
}

async function collectTargets(scope: "all" | "root" | "backend" | "frontend"): Promise<Target[]> {
  const targets: Target[] = [];
  if (scope === "all" || scope === "root") {
    const pkgPath = pathJoin(ROOT, "package.json");
    if (exists(pkgPath)) {
      targets.push({ label: "root", dir: ROOT, paths: CLEAN_DIRS.filter((d) => exists(pathJoin(ROOT, d))) });
    }
  }
  if (scope === "all" || scope === "backend") {
    const base = pathJoin(ROOT, KIND_DIR.backend);
    if (exists(base)) {
      targets.push({ label: "backend", dir: base, paths: CLEAN_DIRS.filter((d) => exists(pathJoin(base, d))) });
    }
  }
  if (scope === "all" || scope === "frontend") {
    const base = pathJoin(ROOT, KIND_DIR.frontend);
    if (exists(base)) {
      targets.push({ label: "frontend", dir: base, paths: CLEAN_DIRS.filter((d) => exists(pathJoin(base, d))) });
    }
  }
  return targets;
}

async function measureSize(dir: string, paths: string[]): Promise<number> {
  let total = 0;
  for (const p of paths) {
    const full = pathJoin(dir, p);
    if (!exists(full)) continue;
    try {
      const walk = async (d: string): Promise<number> => {
        let s = 0;
        const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          const child = pathJoin(d, e.name);
          if (e.isDirectory()) s += await walk(child);
          else if (e.isFile()) {
            try {
              const st = await stat(child);
              s += st.size;
            } catch {}
          }
        }
        return s;
      };
      total += await walk(full);
    } catch {}
  }
  return total;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function clean(scope: "all" | "root" | "backend" | "frontend" = "all", opts: { dry?: boolean; force?: boolean } = {}) {
  log.step(`Cleaning build artifacts (scope=${scope})${opts.dry ? " [DRY RUN]" : ""}`);

  const targets = await collectTargets(scope);
  if (targets.length === 0) {
    log.warn("nothing to clean");
    return;
  }

  let totalFreed = 0;
  for (const t of targets) {
    if (t.paths.length === 0) {
      log.info(`${t.label}: nothing to remove`);
      continue;
    }
    const size = await measureSize(t.dir, t.paths);
    log.info(`${t.label}: ${t.paths.join(", ")} (${fmtSize(size)})`);
    totalFreed += size;
    if (!opts.dry) {
      for (const p of t.paths) {
        await rm(pathJoin(t.dir, p), { recursive: true, force: true });
      }
    }
  }
  log.ok(`freed ${fmtSize(totalFreed)}${opts.dry ? " (dry run, nothing actually removed)" : ""}`);
}

export async function fresh(opts: { scope?: "all" | "root" | "backend" | "frontend"; force?: boolean } = {}) {
  await clean(opts.scope ?? "all", { force: opts.force });
  const pm = await loadPm();
  log.step(`Reinstalling everything with ${pm}...`);

  const targets = await collectTargets(opts.scope ?? "all");
  for (const t of targets) {
    if (!exists(pathJoin(t.dir, "package.json"))) {
      log.warn(`${t.label}: no package.json, skipping`);
      continue;
    }
    log.info(`installing ${t.label}...`);
    const proc = Bun.spawn([pm, "install"], {
      cwd: t.dir,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ADBLOCK: "1", NPM_CONFIG_FUND: "false" },
    });
    const code = await proc.exited;
    if (code !== 0) {
      log.warn(`${t.label}: ${pm} install exited with code ${code}`);
    }
  }
  log.ok("fresh install complete");
}
