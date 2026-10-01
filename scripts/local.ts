// Safe local preview: a dedicated database, no worker and no outbound side effects.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
const action = process.argv[2];
const valves = { COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" };

if (action === "init") {
  if (existsSync(envFile)) throw new Error(".env.local already exists; preserved. Edit it directly if needed.");
  const at = process.argv.indexOf("--database-url");
  const database = process.argv[at + 1] && at >= 0 ? process.argv[at + 1]! : "postgres://127.0.0.1:5432/evalfrontier_local";
  const url = new URL(database);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/_(local|test|ci)$/.test(url.pathname)) {
    throw new Error("Use a dedicated localhost database ending in _local, _test or _ci.");
  }
  writeFileSync(envFile, [
    `DATABASE_URL=${JSON.stringify(database)}`, "SITE_URL=http://localhost:3000", "API_BASE_URL=http://127.0.0.1:3001",
    "AIHOT_ENVIRONMENT=development", `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
    `IMG_PROXY_SIGN_SECRET=${randomBytes(32).toString("hex")}`, `ADMIN_PASSWORD=${randomBytes(18).toString("hex")}`,
    ...Object.entries(valves).map(([key, value]) => `${key}=${value}`), "",
  ].join("\n"), { mode: 0o600, flag: "wx" });
  console.log("Created .env.local. Admin password is in that file; no API keys or worker are needed for preview.");
} else {
  if (!existsSync(envFile)) throw new Error("Run npm run local:init first.");
  function run(cmd: string, args: string[]) {
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...valves }, stdio: "inherit" });
    return new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    });
  }
  if (action === "setup") {
    await run(process.execPath, ["--env-file=.env.local", "scripts/migrate.ts"]);
    await run(process.execPath, ["--env-file=.env.local", "scripts/seed.ts"]);
    await run("npm", ["run", "build", "-w", "@aihot/web"]);
  } else if (action === "start") {
    const children = ["apps/api/src/main.ts", "apps/web/server.ts"].map((script) => spawn(process.execPath, ["--env-file=.env.local", script], { cwd: root, env: { ...process.env, ...valves }, stdio: "inherit" }));
    const stop = () => children.forEach((child) => child.kill("SIGTERM"));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
    for (const child of children) {
      child.once("error", (error) => { console.error(error); process.exitCode = 1; stop(); });
      child.once("exit", (code) => { if (code) process.exitCode = code; stop(); });
    }
  } else throw new Error("Usage: node scripts/local.ts init|setup|start");
}
