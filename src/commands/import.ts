import { exists, log, ensureDir, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR, c, writeFile } from "../utils";
import { mkdir, readFile, readdir, stat, symlink, lstat } from "node:fs/promises";

interface Candidate {
  name: string;
  absPath: string;
  pkgPath: string;
  classification: "be" | "fe" | "unknown";
  reasons: string[];
}

const BE_DEPS = ["elysia", "express", "fastify", "hono", "koa", "nestjs", "@nestjs/core", "restify", "polka", "bun-serve"];
const FE_DEPS = ["next", "react", "react-dom", "vite", "svelte", "@sveltejs/kit", "nuxt", "@angular/core", "vue", "@vue/runtime-core"];

export async function importApps(sourceDir: string, opts: { all?: boolean; force?: boolean; kind?: "be" | "fe" } = {}) {
  const absSource = pathJoin(ROOT, sourceDir);
  if (!exists(absSource)) {
    log.err(`source directory not found: ${absSource}`);
    process.exit(1);
  }

  if (!exists(pathJoin(ROOT, KIND_DIR.backend, "package.json")) && !exists(pathJoin(ROOT, KIND_DIR.frontend, "package.json"))) {
    log.err(`monorepo not initialized. Run: mx init`);
    process.exit(1);
  }

  log.step(`Scanning ${absSource} for apps...`);
  const candidates = await scanCandidates(absSource);

  if (candidates.length === 0) {
    log.warn(`no package.json found in subdirs of ${absSource}`);
    return;
  }

  console.log();
  console.log(`  ${c.dim}${"path".padEnd(40)} ${"kind".padEnd(6)} ${"name".padEnd(20)} reasons${c.reset}`);
  for (const cand of candidates) {
    const kindTag = cand.classification === "be" ? `${c.cyan}BE${c.reset}` : cand.classification === "fe" ? `${c.magenta}FE${c.reset}` : `${c.dim}??${c.reset}`;
    const pathShort = cand.absPath.replace(ROOT + "/", "").padEnd(40);
    const reasons = cand.reasons.slice(0, 2).join(", ");
    console.log(`  ${pathShort} ${kindTag}   ${c.bold}${cand.name.padEnd(20)}${c.reset} ${c.dim}${reasons}${c.reset}`);
  }
  console.log();

  // Decide which to import
  const toImport: Candidate[] = candidates.filter((cand) => {
    if (opts.kind) return cand.classification === opts.kind || cand.classification === "unknown";
    return cand.classification !== "unknown";
  });

  if (toImport.length === 0) {
    log.warn("no importable apps found (use --all to include 'unknown')");
    return;
  }

  if (!opts.force && process.stdin.isTTY) {
    const ok = await confirmYesNo(`Import ${toImport.length} app(s) via symlink into ${KIND_DIR.backend}/apps or ${KIND_DIR.frontend}/apps ? [y/N] `);
    if (!ok) {
      log.info("aborted.");
      return;
    }
  }

  for (const cand of toImport) {
    const kind: AppKind = cand.classification === "fe" ? "frontend" : "backend";
    const prefix: "be" | "fe" = cand.classification === "fe" ? "fe" : "be";
    const targetDir = pathJoin(ROOT, KIND_APPS_DIR[kind], cand.name);

    if (exists(targetDir)) {
      log.warn(`skip ${cand.name}: target already exists at ${targetDir.replace(ROOT + "/", "")}`);
      continue;
    }

    await ensureDir(pathJoin(ROOT, KIND_APPS_DIR[kind]));

    // Use absolute path (symlinks on Windows work fine with absolute targets)
    const linkTarget = cand.absPath;
    try {
      await symlink(linkTarget, targetDir, "dir");
      log.ok(`linked: ${cand.name}  →  ${cand.absPath.replace(ROOT + "/", "")}`);
    } catch (e: any) {
      log.err(`failed to link ${cand.name}: ${e.message}`);
      continue;
    }

    // Patch package.json with missing scripts
    await patchScripts(targetDir, cand);
  }

  log.step("Re-linking workspaces...");
  await relinkWorkspaces();

  log.ok(`imported ${toImport.length} app(s). Run \`mx list\` to verify.`);
}

async function scanCandidates(rootDir: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const absPath = pathJoin(rootDir, e.name);
    const pkgPath = pathJoin(absPath, "package.json");
    if (!exists(pkgPath)) continue;

    let pkg: any;
    try {
      pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const name = (pkg.name as string) || e.name;
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const reasons: string[] = [];
    let classification: "be" | "fe" | "unknown" = "unknown";

    for (const d of BE_DEPS) {
      if (d in allDeps) {
        classification = "be";
        reasons.push(`dep:${d}`);
        break;
      }
    }
    if (classification === "unknown") {
      for (const d of FE_DEPS) {
        if (d in allDeps) {
          classification = "fe";
          reasons.push(`dep:${d}`);
          break;
        }
      }
    }
    if (classification === "unknown" && pkg.scripts) {
      if ("dev" in pkg.scripts && /\b(serve|listen|start)\b/.test(JSON.stringify(pkg.scripts))) {
        classification = "be";
        reasons.push("script:serve");
      } else if ("dev" in pkg.scripts && /\b(next|vite|nuxt|svelte)\b/.test(JSON.stringify(pkg.scripts))) {
        classification = "fe";
        reasons.push("script:next/vite");
      }
    }

    // If src/ has pages or app/ folder, likely FE
    if (classification === "unknown") {
      if (exists(pathJoin(absPath, "src/app")) || exists(pathJoin(absPath, "pages"))) {
        classification = "fe";
        reasons.push("dir:app/pages");
      } else if (exists(pathJoin(absPath, "src/index.ts")) || exists(pathJoin(absPath, "src/main.ts"))) {
        // ambiguous - keep unknown unless explicitly BE
      }
    }

    out.push({ name, absPath, pkgPath, classification, reasons });
  }
  return out;
}

async function patchScripts(targetDir: string, cand: Candidate) {
  // Read package.json through the symlink
  let pkg: any;
  try {
    pkg = JSON.parse(await readFile(pathJoin(targetDir, "package.json"), "utf8"));
  } catch {
    return;
  }

  pkg.scripts = pkg.scripts ?? {};
  let patched = false;
  if (!pkg.scripts.dev) {
    pkg.scripts.dev = pkg.scripts.start ? pkg.scripts.start : "node .";
    patched = true;
  }
  if (!pkg.scripts.build) {
    pkg.scripts.build = "echo 'no build script' && exit 0";
    patched = true;
  }
  if (!pkg.scripts.typecheck) {
    pkg.scripts.typecheck = exists(pathJoin(targetDir, "tsconfig.json")) ? "tsc --noEmit" : "echo 'no tsconfig'";
    patched = true;
  }

  // Patch name to mx convention (be-<name> / fe-<name>)
  const prefix = cand.classification === "fe" ? "fe" : "be";
  const newName = `${prefix}-${cand.name.replace(/^(be|fe)-/, "")}`;
  if (pkg.name !== newName) {
    pkg.name = newName;
    patched = true;
  }

  if (patched) {
    // Write back to the symlinked target (this modifies the source)
    try {
      await writeFile(pathJoin(targetDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
      log.info(`patched scripts in ${cand.name}/package.json`);
    } catch (e: any) {
      log.warn(`could not patch ${cand.name}/package.json (read-only?): ${e.message}`);
    }
  }
}

async function relinkWorkspaces() {
  const { loadPm } = await import("../utils");
  const pm = await loadPm();
  for (const kind of ["backend", "frontend"] as AppKind[]) {
    const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
    if (!exists(pathJoin(rootDir, "package.json"))) continue;
    log.info(`re-linking ${kind} (${pm} install)...`);
    const proc = Bun.spawn([pm, "install"], {
      cwd: rootDir,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ADBLOCK: "1", NPM_CONFIG_FUND: "false" },
    });
    await proc.exited;
  }
}

function confirmYesNo(question: string): Promise<boolean> {
  const stdout = process.stdout;
  const stdin = process.stdin;
  stdout.write(`\x1b[33m?\x1b[0m ${question}`);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.includes("\n") || input.includes("\r")) {
        stdin.removeListener("data", onData);
        stdin.pause();
        const c = input.trim().toLowerCase();
        resolve(c === "y" || c === "yes");
      }
    };
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}
