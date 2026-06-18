#!/usr/bin/env bun
import { Command } from "commander";
import { init } from "./commands/init";
import { addBe, addFe, AddOptions } from "./commands/add";
import { run } from "./commands/run";
import { list } from "./commands/list";
import { removeApp } from "./commands/remove";
import { doctor } from "./commands/doctor";
import { execInApp } from "./commands/exec";
import { addPackage } from "./commands/pkg";
import { linkPackage } from "./commands/link";
import { renameApp } from "./commands/rename";
import { format } from "./commands/format";
import { typecheck } from "./commands/typecheck";
import { setupHusky } from "./commands/husky";
import { tailLogs, listLogs } from "./commands/logs";
import { shell } from "./commands/shell";
import { clean, fresh } from "./commands/clean";
import { stats } from "./commands/stats";
import { graph } from "./commands/graph";
import { envDiff } from "./commands/envdiff";
import { audit } from "./commands/audit";
import { outdated } from "./commands/outdated";
import { promptChoice } from "./utils";

const program = new Command();

program
  .name("mx")
  .description("Monorepo CLI for backend (Bun workspaces) + frontend (Turborepo) apps")
  .version("1.0.0");

// --pm and --scope options reused across init/add/format
function pmOpts(cmd: Command) {
  return cmd.option("--pm <pm>", "package manager override");
}
function appKindOpts(cmd: Command) {
  return cmd.option("--db <db>", "database adapter: postgres | mysql | sqlite | mongo | none")
    .option("--port <port>", "override default port")
    .option("--with-auth", "include auth module (BE only)")
    .option("--no-cors", "skip cors middleware");
}

program
  .command("init")
  .description("Initialize monorepo skeleton")
  .option("--pm <pm>", "package manager: bun | pnpm | yarn | npm")
  .option("--scope <scope>", "what to init: backend | frontend | all")
  .action(init);

program
  .command("add:be <name>")
  .description("Scaffold a new Bun backend app under backend/apps/<name>")
  .option("--db <db>", "database: postgres | mysql | sqlite | mongo | none")
  .option("--port <port>", "override default port 3001")
  .option("--with-auth", "include auth module")
  .option("--no-cors", "skip cors middleware")
  .action((name, opts) => {
    const addOpts: AddOptions = {
      db: opts.db,
      port: opts.port,
      withAuth: opts.withAuth,
      withCors: opts.cors !== false,
    };
    return addBe(name, addOpts);
  });

program
  .command("add:fe <name>")
  .description("Scaffold a new Next.js frontend app under frontend/apps/<name>")
  .option("--port <port>", "override auto-incremented port")
  .action((name, opts) => addFe(name, { port: opts.port }));

program
  .command("add <name>")
  .description("Interactive: scaffold a new app (prompts for backend/frontend)")
  .option("--db <db>", "database: postgres | mysql | sqlite | mongo | none")
  .option("--port <port>", "override port")
  .option("--with-auth", "include auth module (BE)")
  .option("--no-cors", "skip cors middleware")
  .action(async (name, opts) => {
    const choice = await promptChoice(
      "Which kind of app?",
      [
        { value: "backend", label: "backend", description: "Bun + Elysia (BE)" },
        { value: "frontend", label: "frontend", description: "Next.js (FE)" },
      ],
      "backend"
    );
    if (choice === "backend") {
      await addBe(name, { db: opts.db, port: opts.port, withAuth: opts.withAuth, withCors: opts.cors !== false });
    } else {
      await addFe(name, { port: opts.port });
    }
  });

program
  .command("remove <kind> <name>")
  .description("Remove an app: mx remove <be|fe> <name>")
  .option("-f, --force", "skip confirmation")
  .action((kind, name, opts) => {
    if (kind !== "be" && kind !== "fe") {
      console.error("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    return removeApp(kind, name, opts);
  });

program
  .command("rename <kind> <old> <new>")
  .description("Rename an app and update package.json name + port")
  .action((kind, oldName, newName) => {
    if (kind !== "be" && kind !== "fe") {
      console.error("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    return renameApp(kind, oldName, newName);
  });

program
  .command("pkg:add <kind> <name>")
  .description("Create a shared package: mx pkg:add <be|fe> <name>")
  .action((kind, name) => {
    if (kind !== "be" && kind !== "fe") {
      console.error("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    return addPackage(kind, name);
  });

program
  .command("link <kind> <app> <pkg>")
  .description("Link a shared package into an app")
  .action((kind, app, pkg) => {
    if (kind !== "be" && kind !== "fe") {
      console.error("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    return linkPackage(kind, app, pkg);
  });

program
  .command("list")
  .description("List all BE + FE apps")
  .option("--json", "output JSON")
  .action((opts) => list(opts));

program
  .command("doctor")
  .description("Run health checks (PM, lockfile, ports, scripts)")
  .action(doctor);

program
  .command("stats")
  .description("Monorepo stats (apps, LOC, deps, disk usage, last commit)")
  .action(() => stats());

program
  .command("graph")
  .description("Print dep graph (apps + shared packages + externals)")
  .option("--dot", "output Graphviz DOT format instead of ASCII")
  .action((opts) => graph(opts));

program
  .command("format")
  .description("Run prettier (or biome) across all BE + FE apps")
  .action(format);

program
  .command("typecheck")
  .description("Run tsc --noEmit across all BE + FE apps in parallel")
  .action(typecheck);

program
  .command("audit")
  .description("Run security audit (CVE scan) across all apps")
  .option("--scope <scope>", "backend | frontend | all")
  .action((opts) => audit(opts));

program
  .command("outdated")
  .description("Check for outdated dependencies across all apps")
  .option("--scope <scope>", "backend | frontend | all")
  .option("--json", "output JSON")
  .action((opts) => outdated(opts));

program
  .command("clean [scope]")
  .description("Remove node_modules, dist, .next, .turbo (scope: all | backend | frontend)")
  .option("--dry", "show what would be removed without removing")
  .action((scope, opts) => clean((scope as any) ?? "all", opts));

program
  .command("fresh [scope]")
  .description("Clean + reinstall all dependencies (scope: all | backend | frontend)")
  .action((scope) => fresh({ scope: scope as any }));

program
  .command("logs [kind] [name]")
  .description("List log files, or tail: mx logs <be|fe> <name> [-f]")
  .option("-f, --follow", "follow log output (tail -f)")
  .option("-n, --lines <n>", "number of lines to show", "50")
  .action(async (kind, name, opts) => {
    if (!kind) return listLogs();
    if (kind !== "be" && kind !== "fe") {
      console.error("usage: mx logs [be|fe] <name> [-f]");
      process.exit(1);
    }
    if (!name) return listLogs();
    return tailLogs(kind, name, { follow: opts.follow, lines: parseInt(opts.lines, 10) });
  });

program
  .command("shell <kind> <name>")
  .description("Drop to a shell inside the app folder")
  .action((kind, name) => {
    if (kind !== "be" && kind !== "fe") {
      console.error("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    return shell(kind, name);
  });

program
  .command("envdiff <kind> <a> <b>")
  .description("Compare env keys between two apps: mx envdiff be api web")
  .action((kind, a, b) => {
    if (kind !== "be" && kind !== "fe") {
      console.error("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    return envDiff(kind, a, b);
  });

program
  .command("exec <kind> <name> [args...]")
  .description("Run a command (or package.json script) inside an app: mx exec be api -- bun test")
  .action((kind, name, args) => {
    if (kind !== "be" && kind !== "fe") {
      console.error("kind must be 'be' or 'fe'");
      process.exit(1);
    }
    return execInApp(kind, name, args ?? []);
  });

program
  .command("setup")
  .description("Configure monorepo tools (husky, etc)")
  .option("--husky", "install husky + lint-staged git hooks")
  .action((opts) => {
    if (opts.husky) return setupHusky();
    console.error("specify a setup task, e.g. --husky");
    process.exit(1);
  });

const runCmd = program
  .command("run")
  .description("Run apps (be | fe | all) with a script (dev | build | ...)");

runCmd
  .command("be <name> <script>")
  .description("Run a backend app script")
  .option("--log", "also write output to .mx/logs/<prefix>-<name>.log")
  .action((name, script, opts) => run("be", name, script, opts));

runCmd
  .command("fe <name> <script>")
  .description("Run a frontend app script")
  .option("--log", "also write output to .mx/logs/<prefix>-<name>.log")
  .action((name, script, opts) => run("fe", name, script, opts));

runCmd
  .command("all <script>")
  .description("Run the script across ALL BE + FE apps in parallel")
  .option("--log", "also write output to .mx/logs/<prefix>-<name>.log per app")
  .action((script, opts) => run("all", "", script, opts));

program.parseAsync(process.argv).catch((err) => {
  console.error("\x1b[31m[mx] error:\x1b[0m", err.message ?? err);
  process.exit(1);
});
