import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR, PackageManager, loadPm } from "../utils";
import { readdir, readFile } from "node:fs/promises";

export async function audit(opts: { scope?: "all" | "backend" | "frontend" } = {}) {
  log.step(`Running security audit (scope=${opts.scope ?? "all"})`);
  const pm = await loadPm();
  const targets = await collectTargets(opts.scope ?? "all");

  if (targets.length === 0) {
    log.warn("no apps to audit");
    return;
  }

  const procs = targets.map(async (t) => {
    if (!exists(pathJoin(t.dir, "package.json"))) {
      log.warn(`${t.label}: no package.json, skipping`);
      return { label: t.label, code: 0, output: "" };
    }
    const argv = auditArgs(pm);
    log.info(`auditing ${t.label}: ${argv.join(" ")}`);
    const proc = Bun.spawn(argv, {
      cwd: t.dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { label: t.label, code, output: stdout + stderr };
  });

  const results = await Promise.all(procs);
  for (const r of results) {
    console.log();
    console.log(`\x1b[1m=== ${r.label} ===\x1b[0m`);
    if (r.output.trim()) console.log(r.output.trim());
    else console.log("  (no output)");
  }

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    log.err(`${failed.length} target(s) reported vulnerabilities`);
    process.exit(1);
  } else {
    log.ok("no vulnerabilities found");
  }
}

function auditArgs(pm: PackageManager): string[] {
  if (pm === "bun") return ["bun", "audit"];
  if (pm === "pnpm") return ["pnpm", "audit"];
  if (pm === "yarn") return ["yarn", "audit"];
  return ["npm", "audit"];
}

interface Target { label: string; dir: string }
async function collectTargets(scope: "all" | "backend" | "frontend"): Promise<Target[]> {
  const out: Target[] = [];
  if (scope === "all" || scope === "backend") {
    const base = pathJoin(ROOT, KIND_DIR.backend);
    if (exists(base)) {
      out.push({ label: "backend", dir: base });
      const apps = pathJoin(ROOT, KIND_APPS_DIR.backend);
      if (exists(apps)) {
        for (const d of await readdir(apps, { withFileTypes: true })) {
          if (d.isDirectory() && exists(pathJoin(apps, d.name, "package.json"))) {
            out.push({ label: `backend/apps/${d.name}`, dir: pathJoin(apps, d.name) });
          }
        }
      }
    }
  }
  if (scope === "all" || scope === "frontend") {
    const base = pathJoin(ROOT, KIND_DIR.frontend);
    if (exists(base)) {
      out.push({ label: "frontend", dir: base });
      const apps = pathJoin(ROOT, KIND_APPS_DIR.frontend);
      if (exists(apps)) {
        for (const d of await readdir(apps, { withFileTypes: true })) {
          if (d.isDirectory() && exists(pathJoin(apps, d.name, "package.json"))) {
            out.push({ label: `frontend/apps/${d.name}`, dir: pathJoin(apps, d.name) });
          }
        }
      }
    }
  }
  return out;
}
