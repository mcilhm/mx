import { exists, log, pathJoin, ROOT, AppKind, KIND_APPS_DIR, kindLabel, c, colorFor, isAppDir } from "../utils";
import { readdir, readFile } from "node:fs/promises";

type AppInfo = {
  kind: AppKind;
  name: string;
  dir: string;
  port?: number;
  version?: string;
  scripts: string[];
  hasEnv: boolean;
};

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

async function collect(kind: AppKind): Promise<AppInfo[]> {
  const base = pathJoin(ROOT, KIND_APPS_DIR[kind]);
  if (!exists(base)) return [];
  const entries = await readdir(base, { withFileTypes: true });
  const out: AppInfo[] = [];
  for (const d of entries) {
    if (!(await isAppDir(pathJoin(base, d.name)))) continue;
    const dir = pathJoin(base, d.name);
    const pkgPath = pathJoin(dir, "package.json");
    let version: string | undefined;
    let scripts: string[] = [];
    let port: number | undefined;
    if (exists(pkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
        version = pkg.version;
        scripts = Object.keys(pkg.scripts ?? {});
        const m = JSON.stringify(pkg.scripts ?? {}).match(/--port\s+(\d+)/);
        if (m) port = parseInt(m[1], 10);
      } catch {}
    }
    out.push({
      kind,
      name: d.name,
      dir,
      version,
      port,
      scripts,
      hasEnv: exists(pathJoin(dir, ".env")) || exists(pathJoin(dir, ".env.local")),
    });
  }
  return out;
}

export async function list(opts: { json?: boolean } = {}) {
  const bes = await collect("backend");
  const fes = await collect("frontend");

  if (opts.json) {
    console.log(JSON.stringify({ backend: bes, frontend: fes }, null, 2));
    return;
  }

  const total = bes.length + fes.length;
  log.step(`${total} app(s) found.`);

  const rows: string[] = [];
  rows.push(
    `${c.dim}${"kind".padEnd(5)} ${"path".padEnd(22)} ${"name".padEnd(18)} ${"port".padEnd(6)} ${"env".padEnd(4)} ${"scripts"}${c.reset}`
  );

  const tag = (kind: AppKind) =>
    kind === "backend" ? `${c.dim}BE   ${c.reset}` : `${c.dim}FE   ${c.reset}`;

  for (const a of [...bes, ...fes]) {
    const portStr = a.port ? String(a.port) : `${c.dim}-${c.reset}`;
    const envStr = a.hasEnv ? `${c.green}yes${c.reset}` : `${c.dim}no${c.reset}`;
    const scripts = a.scripts.length ? a.scripts.join(", ") : `${c.dim}-${c.reset}`;
    const pathLabel = `${KIND_APPS_DIR[a.kind]}/`;
    const nameColored = `${colorFor(a.name)}${c.bold}${a.name.padEnd(18)}${c.reset}`;
    rows.push(
      `${tag(a.kind)} ${c.dim}${pathLabel.padEnd(22)}${c.reset} ${nameColored} ${portStr.padEnd(6 + 9)} ${envStr.padEnd(4 + 9)} ${scripts}`
    );
  }

  console.log(rows.join("\n"));
}
