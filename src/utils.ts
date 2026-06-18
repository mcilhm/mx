export const ROOT = process.cwd();

export type PackageManager = "bun" | "yarn" | "npm" | "pnpm";

export function detectPkgManager(): PackageManager {
  if (exists(pathJoin(ROOT, "bun.lockb")) || exists(pathJoin(ROOT, "bun.lock"))) return "bun";
  if (exists(pathJoin(ROOT, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(pathJoin(ROOT, "yarn.lock"))) return "yarn";
  if (exists(pathJoin(ROOT, "package-lock.json"))) return "npm";
  return "bun"; // sensible default for this CLI
}

export const CLI_DIR = (() => {
  try {
    // Bun.main is the absolute path to the entry file being executed
    // @ts-ignore - Bun global
    const main: string | undefined = typeof Bun !== "undefined" ? Bun.main : undefined;
    if (main) return main.replace(/[\\/]src[\\/]index\.ts$/, "").replace(/[\\/]dist[\\/]index\.js$/, "");
  } catch {}
  return process.cwd();
})();

export const TEMPLATES_DIR = pathJoin(CLI_DIR, "src", "templates");

export const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

export const log = {
  info: (msg: string) => console.log(`${c.blue}info${c.reset}  ${msg}`),
  ok: (msg: string) => console.log(`${c.green}done${c.reset}  ${msg}`),
  warn: (msg: string) => console.log(`${c.yellow}warn${c.reset}  ${msg}`),
  err: (msg: string) => console.log(`${c.red}error${c.reset} ${msg}`),
  step: (msg: string) => console.log(`${c.magenta}>>>${c.reset}   ${msg}`),
};

export function exists(p: string): boolean {
  try {
    return require("node:fs").existsSync(p);
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(p, { recursive: true });
}

export async function writeFile(p: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await ensureDir(p.substring(0, p.lastIndexOf("/")) || p);
  await writeFile(p, content, "utf8");
}

export function pathJoin(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
}

export type AppKind = "backend" | "frontend";

export const KIND_DIR: Record<AppKind, string> = {
  backend: "backend",
  frontend: "frontend",
};

export const KIND_APPS_DIR: Record<AppKind, string> = {
  backend: "backend/apps",
  frontend: "frontend/apps",
};

export function kindLabel(k: AppKind): string {
  return k === "backend" ? "BE" : "FE";
}

const VALID_PM: PackageManager[] = ["bun", "yarn", "npm", "pnpm"];

export function isValidPm(p: string): p is PackageManager {
  return (VALID_PM as string[]).includes(p);
}

export type Scope = "backend" | "frontend" | "all";

const VALID_SCOPE: Scope[] = ["backend", "frontend", "all"];

export function isValidScope(s: string): s is Scope {
  return (VALID_SCOPE as string[]).includes(s);
}

export const SCOPE_OPTIONS = [
  { value: "all", label: "all", description: "backend + frontend (Recommended)" },
  { value: "backend", label: "backend", description: "only backend/ + apps/* (Bun workspaces)" },
  { value: "frontend", label: "frontend", description: "only frontend/ + apps/* (Turborepo)" },
];

export async function promptChoice(
  question: string,
  options: { value: string; label: string; description?: string }[],
  defaultValue: string
): Promise<string> {
  // If stdin is not a TTY (CI, piped), use default
  if (!process.stdin.isTTY) {
    log.info(`${question} -> ${defaultValue} (non-interactive default)`);
    return defaultValue;
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  stdout.write(`\n${c.bold}${question}${c.reset}\n`);
  options.forEach((opt, i) => {
    const marker = opt.value === defaultValue ? `${c.green}*${c.reset}` : " ";
    const hint = opt.description ? `${c.dim} - ${opt.description}${c.reset}` : "";
    stdout.write(`  ${marker} ${c.cyan}${i + 1})${c.reset} ${opt.label}${hint}\n`);
  });
  stdout.write(`\nSelect [1-${options.length}] (default ${c.bold}${defaultValue}${c.reset}): `);

  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.includes("\n") || input.includes("\r")) {
        stdin.removeListener("data", onData);
        stdin.pause();
        const choice = input.trim();
        stdout.write("\n");
        if (!choice) {
          resolve(defaultValue);
          return;
        }
        const idx = parseInt(choice, 10);
        if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
          resolve(options[idx - 1].value);
          return;
        }
        // also accept raw value
        const byValue = options.find((o) => o.value === choice);
        if (byValue) {
          resolve(byValue.value);
          return;
        }
        log.warn(`invalid choice '${choice}', using default '${defaultValue}'`);
        resolve(defaultValue);
      }
    };
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

export const PM_OPTIONS = [
  { value: "bun", label: "bun", description: "fast, native TS, built-in workspaces (Recommended)" },
  { value: "pnpm", label: "pnpm", description: "fast, disk-efficient, strict node_modules" },
  { value: "yarn", label: "yarn", description: "classic Yarn 1.x workspaces" },
  { value: "npm", label: "npm", description: "built-in, widely supported" },
];

export function pmInstallArgs(pm: PackageManager): string[] {
  if (pm === "bun") return ["install"];
  if (pm === "pnpm") return ["install"];
  if (pm === "yarn") return ["install"];
  return ["install"];
}

export function pmRunArgs(pm: PackageManager, script: string): string[] {
  if (pm === "bun") return ["run", script];
  if (pm === "pnpm") return ["run", script];
  if (pm === "yarn") return [script];
  return ["run", script];
}

const CONFIG_PATH_DEFAULT = pathJoin(ROOT, ".mx/config.json");

export async function loadPm(): Promise<PackageManager> {
  if (exists(CONFIG_PATH_DEFAULT)) {
    try {
      const { readFile } = await import("node:fs/promises");
      const cfg = JSON.parse(await readFile(CONFIG_PATH_DEFAULT, "utf8"));
      if (isValidPm(cfg.packageManager)) return cfg.packageManager;
    } catch {}
  }
  return detectPkgManager();
}
