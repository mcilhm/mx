import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR, PackageManager, loadPm } from "../utils";
import { readdir, readFile, stat } from "node:fs/promises";

export async function stats() {
  log.step("Monorepo statistics");

  const summary = {
    apps: { backend: 0, frontend: 0 },
    totalDeps: 0,
    totalDevDeps: 0,
    loc: { ts: 0, tsx: 0, js: 0, css: 0, total: 0 },
    diskUsage: 0,
    lastCommit: "no git",
  };

  // Git last commit
  try {
    const proc = Bun.spawn(["git", "log", "-1", "--format=%h %s (%ai)"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if ((await proc.exited) === 0) {
      summary.lastCommit = (await new Response(proc.stdout).text()).trim();
    }
  } catch {}

  for (const kind of ["backend", "frontend"] as AppKind[]) {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(base)) continue;
    const dirs = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory());
    summary.apps[kind] = dirs.length;
    for (const d of dirs) {
      const dir = pathJoin(base, d.name);
      const pkgPath = pathJoin(dir, "package.json");
      if (!exists(pkgPath)) continue;
      try {
        const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
        summary.totalDeps += Object.keys(pkg.dependencies ?? {}).length;
        summary.totalDevDeps += Object.keys(pkg.devDependencies ?? {}).length;
      } catch {}
      await countLoc(dir, summary.loc);
    }
  }

  // Total disk usage of node_modules
  for (const p of [
    pathJoin(ROOT, "node_modules"),
    pathJoin(ROOT, "backend/node_modules"),
    pathJoin(ROOT, "frontend/node_modules"),
  ]) {
    if (exists(p)) summary.diskUsage += await dirSize(p);
  }

  console.log();
  console.log(`  ${bold("Apps")}              backend: ${summary.apps.backend}  frontend: ${summary.apps.frontend}`);
  console.log(`  ${bold("Dependencies")}      ${summary.totalDeps} prod + ${summary.totalDevDeps} dev = ${summary.totalDeps + summary.totalDevDeps} total`);
  console.log(`  ${bold("Source code")}       ${summary.loc.ts} .ts + ${summary.loc.tsx} .tsx + ${summary.loc.js} .js + ${summary.loc.css} .css = ${summary.loc.total} files`);
  console.log(`  ${bold("node_modules")}      ${fmtSize(summary.diskUsage)}`);
  console.log(`  ${bold("Last commit")}       ${summary.lastCommit}`);
  console.log();
}

async function countLoc(dir: string, loc: { ts: number; tsx: number; js: number; css: number; total: number }) {
  const exts: Record<string, keyof typeof loc> = {
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".jsx": "js",
    ".css": "css",
  };
  const walk = async (d: string, depth = 0) => {
    if (depth > 5) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const child = pathJoin(d, e.name);
      if (e.isDirectory()) await walk(child, depth + 1);
      else if (e.isFile()) {
        const ext = exts[e.name.substring(e.name.lastIndexOf("."))];
        if (ext) {
          loc[ext]++;
          loc.total++;
        }
      }
    }
  };
  await walk(dir);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string, depth = 0): Promise<void> => {
    if (depth > 8) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const child = pathJoin(d, e.name);
      if (e.isDirectory()) await walk(child, depth + 1);
      else if (e.isFile()) {
        try {
          const st = await stat(child);
          total += st.size;
        } catch {}
      }
    }
  };
  await walk(dir);
  return total;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function bold(s: string): string {
  return `\x1b[1m${s.padEnd(16)}\x1b[0m`;
}
