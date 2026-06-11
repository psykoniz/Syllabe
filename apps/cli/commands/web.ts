import { Command } from "commander";
import { join } from "path";
import { spawnSync } from "child_process";

export const webCommand = new Command("web")
  .description("Start the ProjectOS Web UI")
  .option("--port <n>", "Port to listen on", "4321")
  .option("--db <path>", "SQLite database path", join(process.cwd(), ".projectos", "runs.db"))
  .action((opts: { port: string; db: string }) => {
    const serverPath = new URL("../../web/server.ts", import.meta.url).pathname;

    process.env["PROJECTOS_DB_PATH"] = opts.db;
    process.env["PORT"] = opts.port;

    console.log(`Starting ProjectOS Web UI on http://localhost:${opts.port}`);
    console.log(`DB: ${opts.db}`);

    const result = spawnSync("bun", [serverPath], {
      stdio: "inherit",
      env: process.env,
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  });
