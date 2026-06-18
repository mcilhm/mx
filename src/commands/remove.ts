import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, KIND_DIR } from "../utils";
import { rm } from "node:fs/promises";

export async function removeApp(prefix: "be" | "fe", name: string, opts: { force?: boolean } = {}) {
  const kind: AppKind = prefix === "be" ? "backend" : "frontend";
  const dir = pathJoin(ROOT, KIND_APPS_DIR[kind], name);

  if (!exists(dir)) {
    log.err(`App not found: ${dir}`);
    process.exit(1);
  }

  if (!opts.force && process.stdin.isTTY) {
    const ok = await confirm(`Delete ${KIND_APPS_DIR[kind]}/${name}? This cannot be undone.`);
    if (!ok) {
      log.info("aborted.");
      return;
    }
  }

  await rm(dir, { recursive: true, force: true });
  log.ok(`removed: ${KIND_APPS_DIR[kind]}/${name}`);

  // Re-link workspaces so node_modules symlinks don't point to ghost dirs
  const rootDir = pathJoin(ROOT, KIND_DIR[kind]);
  if (exists(pathJoin(rootDir, "package.json"))) {
    log.info(`re-linking ${kind} workspace...`);
    const pm = await loadPmChoice();
    await Bun.spawn([pm, "install"], {
      cwd: rootDir,
      stdio: ["inherit", "inherit", "inherit"],
    }).exited;
  }
}

function confirm(question: string): Promise<boolean> {
  const stdout = process.stdout;
  const stdin = process.stdin;
  stdout.write(`\n\x1b[33m?\x1b[0m ${question} [y/N] `);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.includes("\n") || input.includes("\r")) {
        stdin.removeListener("data", onData);
        stdin.pause();
        const c = input.trim().toLowerCase();
        stdout.write("\n");
        resolve(c === "y" || c === "yes");
      }
    };
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function loadPmChoice(): Promise<"bun" | "pnpm" | "yarn" | "npm"> {
  const cfgPath = pathJoin(ROOT, ".mx/config.json");
  if (exists(cfgPath)) {
    try {
      const { readFile } = await import("node:fs/promises");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      if (["bun", "pnpm", "yarn", "npm"].includes(cfg.packageManager)) {
        return cfg.packageManager;
      }
    } catch {}
  }
  return "bun";
}
