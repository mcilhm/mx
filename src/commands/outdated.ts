import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR, c } from "../utils";
import { readdir, readFile } from "node:fs/promises";

interface OutdatedInfo {
  name: string;
  current: string;
  wanted: string;
  latest: string;
}

export async function outdated(opts: { scope?: "all" | "backend" | "frontend"; json?: boolean } = {}) {
  log.step(`Checking outdated dependencies (scope=${opts.scope ?? "all"})`);

  const targets: { label: string; dir: string }[] = [];
  for (const kind of ["backend", "frontend"] as AppKind[]) {
    if (opts.scope && opts.scope !== "all" && opts.scope !== kind) continue;
    const appsBase = pathJoin(ROOT, KIND_APPS_DIR[kind]);
    if (!exists(appsBase)) continue;
    for (const d of await readdir(appsBase, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = pathJoin(appsBase, d.name);
      if (exists(pathJoin(dir, "package.json"))) {
        targets.push({ label: `${kind}/${d.name}`, dir });
      }
    }
  }

  if (targets.length === 0) {
    log.warn("no apps found");
    return;
  }

  const allResults: { label: string; outdated: OutdatedInfo[] }[] = [];
  for (const t of targets) {
    const deps = await readDeps(t.dir);
    if (deps.length === 0) continue;
    const outdated: OutdatedInfo[] = [];
    // Query registry in batches of 20
    for (let i = 0; i < deps.length; i += 20) {
      const batch = deps.slice(i, i + 20);
      const results = await Promise.all(batch.map((d) => fetchLatest(d.name, d.current)));
      for (const r of results) {
        if (r && r.latest && r.latest !== r.current && compareSemver(r.latest, r.current) > 0) {
          outdated.push(r);
        }
      }
    }
    if (!opts.json && outdated.length > 0) {
      log.info(`${t.label}: ${outdated.length} outdated`);
    }
    allResults.push({ label: t.label, outdated });
  }

  if (opts.json) {
    console.log(JSON.stringify(allResults, null, 2));
    return;
  }

  console.log();
  for (const r of allResults) {
    if (r.outdated.length === 0) {
      console.log(`  ${c.green}\u2713${c.reset} ${r.label.padEnd(40)} up to date`);
      continue;
    }
    console.log(`  ${c.yellow}!${c.reset} ${r.label.padEnd(40)} ${r.outdated.length} outdated:`);
    console.log(`    ${"package".padEnd(30)} ${"current".padEnd(15)} ${"latest".padEnd(15)}`);
    for (const o of r.outdated.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${o.name.padEnd(30)} ${c.dim}${o.current.padEnd(15)}${c.reset} ${c.green}${o.latest.padEnd(15)}${c.reset}`);
    }
  }
  console.log();
}

async function readDeps(dir: string): Promise<{ name: string; current: string }[]> {
  const pkgPath = pathJoin(dir, "package.json");
  if (!exists(pkgPath)) return [];
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Object.entries(all).map(([name, current]) => ({ name, current: current as string }));
  } catch {
    return [];
  }
}

async function fetchLatest(name: string, current: string): Promise<OutdatedInfo | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return {
      name,
      current: current.replace(/^[\^~]/, ""),
      wanted: data.version ?? "",
      latest: data.version ?? "",
    };
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^[^\d]*/, "").split(".").map(Number);
  const pb = b.replace(/^[^\d]*/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
