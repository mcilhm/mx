import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR } from "../utils";
import { readFile } from "node:fs/promises";

export async function envDiff(prefix: "be" | "fe", a: string, b: string) {
  const kind: AppKind = prefix === "be" ? "backend" : "frontend";
  const dirA = pathJoin(ROOT, KIND_APPS_DIR[kind], a);
  const dirB = pathJoin(ROOT, KIND_APPS_DIR[kind], b);
  if (!exists(dirA) || !exists(dirB)) {
    log.err("one or both apps not found");
    process.exit(1);
  }

  const keysA = await readEnvKeys(dirA);
  const keysB = await readEnvKeys(dirB);

  log.step(`Comparing env keys (${prefix}:${a} vs ${prefix}:${b})`);

  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const common: string[] = [];
  const allKeys = new Set([...keysA, ...keysB]);
  for (const k of allKeys) {
    const inA = keysA.has(k);
    const inB = keysB.has(k);
    if (inA && inB) common.push(k);
    else if (inA) onlyA.push(k);
    else onlyB.push(k);
  }

  console.log();
  console.log(`  \x1b[32m[only in ${a}]\x1b[0m (${onlyA.length})`);
  for (const k of onlyA.sort()) console.log(`    + ${k}`);
  console.log(`  \x1b[36m[only in ${b}]\x1b[0m (${onlyB.length})`);
  for (const k of onlyB.sort()) console.log(`    + ${k}`);
  console.log(`  \x1b[2m[common]\x1b[0m (${common.length})`);
  for (const k of common.sort()) console.log(`    = ${k}`);
  console.log();
}

async function readEnvKeys(dir: string): Promise<Set<string>> {
  // Read from .env.example (always present) and .env (if exists)
  const keys = new Set<string>();
  for (const file of [".env.example", ".env", ".env.local"]) {
    const p = pathJoin(dir, file);
    if (!exists(p)) continue;
    try {
      const raw = await readFile(p, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq > 0) keys.add(t.slice(0, eq).trim());
      }
    } catch {}
  }
  return keys;
}
