#!/usr/bin/env bun
import { Command } from "commander";
import { init } from "./commands/init";
import { addBe, addFe } from "./commands/add";
import { run } from "./commands/run";
import { list } from "./commands/list";

const program = new Command();

program
  .name("mx")
  .description("Monorepo CLI for backend (Bun workspaces) + frontend (Turborepo) apps")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize monorepo skeleton (backend/apps & frontend/apps)")
  .option("--pm <pm>", "package manager to use: bun | pnpm | yarn | npm (otherwise prompted)")
  .action(init);

program
  .command("add:be <name>")
  .description("Scaffold a new Bun backend app under backend/apps/<name>")
  .action(addBe);

program
  .command("add:fe <name>")
  .description("Scaffold a new Next.js frontend app under frontend/apps/<name>")
  .action(addFe);

program
  .command("list")
  .description("List all backend + frontend apps in the monorepo")
  .option("--json", "output JSON")
  .action((opts) => list(opts));

const runCmd = program
  .command("run")
  .description("Run apps (be | fe | all) with a script (dev | build | start | ...)");

runCmd
  .command("be <name> <script>")
  .description("Run a backend app script")
  .action((name, script) => run("be", name, script));

runCmd
  .command("fe <name> <script>")
  .description("Run a frontend app script")
  .action((name, script) => run("fe", name, script));

runCmd
  .command("all <script>")
  .description("Run the script across ALL BE + FE apps in parallel")
  .action((script) => run("all", "", script));

program.parseAsync(process.argv).catch((err) => {
  console.error("\x1b[31m[mx] error:\x1b[0m", err.message ?? err);
  process.exit(1);
});
