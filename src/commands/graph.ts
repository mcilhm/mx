import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR } from "../utils";
import { readdir, readFile } from "node:fs/promises";

type Node = { id: string; kind: "app" | "pkg" | "external" };
type Edge = { from: string; to: string };

interface Graph {
  nodes: Node[];
  edges: Edge[];
}

export async function graph(opts: { dot?: boolean } = {}) {
  log.step("Building dependency graph...");

  const g: Graph = { nodes: [], edges: [] };

  // Walk all apps + packages, collect their deps
  for (const kind of ["backend", "frontend"] as AppKind[]) {
    const root = pathJoin(ROOT, KIND_DIR[kind]);
    if (!exists(root)) continue;

    // packages in <root>/packages/*
    const pkgBase = pathJoin(root, "packages");
    if (exists(pkgBase)) {
      for (const d of await readdir(pkgBase, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const pkgPath = pathJoin(pkgBase, d.name, "package.json");
        if (!exists(pkgPath)) continue;
        const id = await readPkgName(pkgPath) ?? `${kind}-${d.name}`;
        g.nodes.push({ id, kind: "pkg" });
        await collectDeps(pkgPath, g, id, kind);
      }
    }

    // apps in <root>/apps/*
    const appBase = pathJoin(root, "apps");
    if (!exists(appBase)) continue;
    for (const d of await readdir(appBase, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pkgPath = pathJoin(appBase, d.name, "package.json");
      if (!exists(pkgPath)) continue;
      const id = await readPkgName(pkgPath) ?? `${kind === "backend" ? "be" : "fe"}-${d.name}`;
      g.nodes.push({ id, kind: "app" });
      await collectDeps(pkgPath, g, id, kind);
    }
  }

  if (opts.dot) {
    printDot(g);
  } else {
    printAscii(g);
  }
}

async function readPkgName(pkgPath: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

async function collectDeps(pkgPath: string, g: Graph, fromId: string, kind: AppKind) {
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const depName of Object.keys(deps)) {
      const version = deps[depName];
      // workspace deps (workspace:* or link:) → internal
      if (typeof version === "string" && (version.startsWith("workspace:") || version.startsWith("link:"))) {
        const internalId = depName; // already prefixed
        if (g.nodes.find((n) => n.id === internalId)) {
          g.edges.push({ from: fromId, to: internalId });
        }
      } else {
        // external
        if (!g.nodes.find((n) => n.id === depName)) {
          g.nodes.push({ id: depName, kind: "external" });
        }
        g.edges.push({ from: fromId, to: depName });
      }
    }
  } catch {}
}

function printAscii(g: Graph) {
  if (g.nodes.length === 0) {
    log.warn("no apps or packages found");
    return;
  }
  // Group by kind
  const apps = g.nodes.filter((n) => n.kind === "app");
  const pkgs = g.nodes.filter((n) => n.kind === "pkg");
  const externals = g.nodes.filter((n) => n.kind === "external");

  console.log();
  console.log(`  \x1b[36m[apps]\x1b[0m`);
  for (const n of apps) {
    const out = g.edges.filter((e) => e.from === n.id);
    const internalDeps = out.filter((e) => g.nodes.find((x) => x.id === e.to)?.kind !== "external");
    const externalDeps = out.filter((e) => g.nodes.find((x) => x.id === e.to)?.kind === "external");
    console.log(`    ${n.id.padEnd(28)} -> ${internalDeps.map((e) => `\x1b[33m${e.to}\x1b[0m`).join(", ") || "-"}`);
    if (externalDeps.length > 0) {
      console.log(`      ${"\u00b7".padEnd(28)}    (${externalDeps.length} external: ${externalDeps.slice(0, 5).map((e) => e.to).join(", ")}${externalDeps.length > 5 ? "..." : ""})`);
    }
  }

  if (pkgs.length > 0) {
    console.log(`  \x1b[35m[shared packages]\x1b[0m`);
    for (const n of pkgs) {
      const out = g.edges.filter((e) => e.from === n.id);
      console.log(`    ${n.id.padEnd(28)} -> ${out.map((e) => e.to).join(", ") || "-"}`);
    }
  }

  if (externals.length > 0) {
    console.log(`  \x1b[2m[external deps]\x1b[0m  ${externals.length} unique`);
  }
  console.log();
}

function printDot(g: Graph) {
  console.log("digraph mx {");
  console.log("  rankdir=LR;");
  console.log("  node [shape=box];");
  for (const n of g.nodes) {
    const shape = n.kind === "app" ? "box" : n.kind === "pkg" ? "ellipse" : "plaintext";
    const color = n.kind === "app" ? "lightblue" : n.kind === "pkg" ? "lightyellow" : "gray";
    console.log(`  "${n.id}" [shape=${shape}, style=filled, fillcolor=${color}];`);
  }
  for (const e of g.edges) {
    console.log(`  "${e.from}" -> "${e.to}";`);
  }
  console.log("}");
}
