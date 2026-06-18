import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR, c } from "../utils";
import { readFile, readdir } from "node:fs/promises";

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
};

export async function doctor() {
  log.step("Running health checks...");

  const checks: Check[] = [];

  // 1. .mx/config.json present
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      checks.push({ name: ".mx/config.json", ok: true, detail: `pm=${cfg.packageManager}, scope=${cfg.scope}` });
    } catch (e: any) {
      checks.push({ name: ".mx/config.json", ok: false, detail: `invalid JSON: ${e.message}`, fix: "delete it and run `mx init`" });
    }
  } else {
    checks.push({ name: ".mx/config.json", ok: false, detail: "missing", fix: "run `mx init`" });
  }

  // 2. PM binary available
  const pm = await loadPm();
  const pmCheck = await checkPm(pm);
  checks.push(pmCheck);

  // 3. Lockfile vs PM consistent
  checks.push(await checkLockfileConsistency(pm));

  // 4. Backend/Frontend root present (if claimed in scope)
  const scope = await loadScope();
  checks.push({ name: "backend/", ok: exists(pathJoin(ROOT, "backend")), detail: exists(pathJoin(ROOT, "backend")) ? "present" : "missing", fix: scope === "all" || scope === "backend" ? "run `mx init --scope backend`" : undefined });
  checks.push({ name: "frontend/", ok: exists(pathJoin(ROOT, "frontend")), detail: exists(pathJoin(ROOT, "frontend")) ? "present" : "missing", fix: scope === "all" || scope === "frontend" ? "run `mx init --scope frontend`" : undefined });

  // 5. Port conflicts in FE apps
  const fePortConflicts = await findPortConflicts("frontend");
  if (fePortConflicts.length === 0) {
    checks.push({ name: "frontend port conflicts", ok: true, detail: "no conflicts" });
  } else {
    checks.push({ name: "frontend port conflicts", ok: false, detail: fePortConflicts.join(", "), fix: "rename apps or change --port" });
  }

  // 6. Missing scripts per app
  const scriptIssues = await findMissingScripts();
  if (scriptIssues.length === 0) {
    checks.push({ name: "required scripts", ok: true, detail: "all apps have dev + build" });
  } else {
    checks.push({ name: "required scripts", ok: false, detail: scriptIssues.join(", "), fix: "re-scaffold via `mx add:<be|fe> <name>`" });
  }

  // 7. Orphaned node_modules dirs (apps without package.json)
  const orphans = await findOrphanedApps();
  if (orphans.length === 0) {
    checks.push({ name: "orphaned app dirs", ok: true, detail: "none" });
  } else {
    checks.push({ name: "orphaned app dirs", ok: false, detail: orphans.join(", "), fix: "delete manually" });
  }

  // Render
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  console.log();
  for (const ck of checks) {
    const icon = ck.ok ? `${c.green}\u2713${c.reset}` : `${c.red}\u2717${c.reset}`;
    const line = `  ${icon} ${ck.name.padEnd(28)} ${c.dim}${ck.detail}${c.reset}`;
    console.log(line);
    if (!ck.ok && ck.fix) {
      console.log(`      ${c.yellow}fix: ${ck.fix}${c.reset}`);
    }
  }
  console.log();
  log.ok(`${passed}/${checks.length} checks passed` + (failed > 0 ? `, ${failed} issue(s) found` : ""));

  if (failed > 0) process.exit(1);
}

async function checkPm(pm: string): Promise<Check> {
  try {
    const proc = Bun.spawn([pm, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const code = await proc.exited;
    if (code === 0) {
      const out = await new Response(proc.stdout).text();
      return { name: `${pm} installed`, ok: true, detail: out.trim() };
    }
    return { name: `${pm} installed`, ok: false, detail: "binary returned non-zero", fix: `install ${pm}` };
  } catch {
    return { name: `${pm} installed`, ok: false, detail: "binary not found in PATH", fix: `install ${pm}` };
  }
}

async function checkLockfileConsistency(pm: string): Promise<Check> {
  const locks: Record<string, string> = {
    bun: "bun.lock",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    npm: "package-lock.json",
  };
  const expected = locks[pm];
  if (exists(pathJoin(ROOT, expected))) {
    return { name: "lockfile", ok: true, detail: expected };
  }
  return { name: "lockfile", ok: false, detail: `expected ${expected} for ${pm}`, fix: `run \`${pm} install\`` };
}

async function findPortConflicts(kind: AppKind): Promise<string[]> {
  const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
  if (!exists(base)) return [];
  const seen = new Map<number, string>();
  const conflicts: string[] = [];
  for (const d of await readdir(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const pkgPath = pathJoin(base, d.name, "package.json");
    if (!exists(pkgPath)) continue;
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      const m = JSON.stringify(pkg.scripts ?? {}).match(/--port\s+(\d+)/);
      if (!m) continue;
      const port = parseInt(m[1], 10);
      if (seen.has(port)) {
        conflicts.push(`${seen.get(port)} & ${d.name} -> ${port}`);
      } else {
        seen.set(port, d.name);
      }
    } catch {}
  }
  return conflicts;
}

async function findMissingScripts(): Promise<string[]> {
  const issues: string[] = [];
  for (const kind of ["backend", "frontend"] as AppKind[]) {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(base)) continue;
    for (const d of await readdir(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pkgPath = pathJoin(base, d.name, "package.json");
      if (!exists(pkgPath)) {
        issues.push(`${kind}/${d.name}: no package.json`);
        continue;
      }
      try {
        const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
        const scripts = pkg.scripts ?? {};
        if (!scripts.dev) issues.push(`${kind}/${d.name}: missing 'dev' script`);
        if (!scripts.build) issues.push(`${kind}/${d.name}: missing 'build' script`);
      } catch {}
    }
  }
  return issues;
}

async function findOrphanedApps(): Promise<string[]> {
  const out: string[] = [];
  for (const kind of ["backend", "frontend"] as AppKind[]) {
    const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(base)) continue;
    for (const d of await readdir(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pkgPath = pathJoin(base, d.name, "package.json");
      if (!exists(pkgPath)) out.push(`${kind}/${d.name}`);
    }
  }
  return out;
}

async function loadPm(): Promise<"bun" | "pnpm" | "yarn" | "npm"> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (["bun", "pnpm", "yarn", "npm"].includes(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return "bun";
}

async function loadScope(): Promise<"backend" | "frontend" | "all" | undefined> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      return cfg.scope;
    } catch {}
  }
  return undefined;
}
