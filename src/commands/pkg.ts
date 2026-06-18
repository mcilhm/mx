import { exists, log, pathJoin, ROOT, AppKind, KIND_DIR, PackageManager, isValidPm, writeFile } from "../utils";
import { mkdir } from "node:fs/promises";
import { addBe, addFe } from "./add";

export async function addPackage(prefix: "be" | "fe", name: string) {
  const kind: AppKind = prefix === "be" ? "backend" : "frontend";
  const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
  if (!exists(rootDir) || !exists(pathJoin(rootDir, "package.json"))) {
    log.err(`${KIND_DIR[kind]}/ not initialized. Run: mx init --scope ${kind}`);
    process.exit(1);
  }
  const dir = pathJoin(rootDir, "packages", name);
  if (exists(dir)) {
    log.err(`Package already exists: ${dir}`);
    process.exit(1);
  }

  await mkdir(dir, { recursive: true });
  await mkdir(pathJoin(dir, "src"), { recursive: true });

  const pkgName = `${prefix === "be" ? "be" : "fe"}-${name}`;
  const pkg = {
    name: pkgName,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "./src/index.ts",
    types: "./src/index.ts",
    scripts: {
      build: "tsc -p tsconfig.json",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    devDependencies: {
      "@types/bun": "latest",
      typescript: "^5.5.0",
    },
  };
  await writeFile(pathJoin(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");

  const tsconfig = {
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      declaration: true,
      noEmit: false,
      outDir: "dist",
      strict: true,
      skipLibCheck: true,
      types: ["bun-types"],
    },
    include: ["src"],
  };
  await writeFile(pathJoin(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n", "utf8");

  const stubKind = prefix === "be" ? "backend" : "frontend";
  const stub = `// Shared ${stubKind} package: ${name}\n// Import from any app as: import { ... } from "${pkgName}";\n\nexport const PACKAGE_NAME = "${name}";\nexport const PACKAGE_KIND = "${stubKind}";\n`;
  await writeFile(pathJoin(dir, "src/index.ts"), stub, "utf8");

  // Update root workspaces to include packages/*
  await updateWorkspaces(rootDir);

  log.ok(`created: ${KIND_DIR[kind]}/packages/${name}`);
  log.info(`import via: import { PACKAGE_NAME } from "${pkgName}";`);

  // Re-link workspaces
  log.info("re-linking workspace...");
  const pm = await loadPm();
  await Bun.spawn([pm, "install"], {
    cwd: rootDir,
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
}

async function updateWorkspaces(rootDir: string) {
  const pkgPath = pathJoin(rootDir, "package.json");
  if (!exists(pkgPath)) return;
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const ws = new Set<string>(pkg.workspaces ?? []);
  ws.add("apps/*");
  ws.add("packages/*");
  pkg.workspaces = Array.from(ws);
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

async function loadPm(): Promise<string> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const { readFile } = await import("node:fs/promises");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (isValidPm(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return "bun";
}
