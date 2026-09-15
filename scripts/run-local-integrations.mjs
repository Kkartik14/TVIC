import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const composeFile = "docker-compose.integration.yml";
const composeProject = "tvic-integration";
const composeArgs = ["compose", "-f", composeFile, "-p", composeProject];

loadLocalEnv();

const databaseUrl =
  process.env.TVIC_POSTGRES_URL ?? "postgres://tvic:tvic_local@127.0.0.1:55432/tvic";
const memoryDatabaseUrl =
  process.env.TVIC_MEMORY_POSTGRES_URL ?? "postgres://tvic:tvic_local@127.0.0.1:55432/tvic_memory";
const redisUrl = process.env.TVIC_REDIS_URL ?? "redis://127.0.0.1:56379";

await run("docker", [...composeArgs, "up", "-d", "--wait"], process.env);
await ensureMemoryDatabase();

const testEnv = {
  ...process.env,
  TVIC_RUN_INTEGRATION: "1",
  DATABASE_URL: databaseUrl,
  MEMORY_INTEGRATION_URL: memoryDatabaseUrl,
  REDIS_URL: redisUrl,
  TURBO_FORCE: "true",
};

try {
  await run(commandName("pnpm"), ["build"], testEnv);
  await run(commandName("pnpm"), ["test"], testEnv);
  await run(commandName("pnpm"), ["--filter", "@tvic/dal-composite", "test"], testEnv);
  await run(commandName("pnpm"), ["--filter", "@tvic/dal-postgres-memory", "test"], testEnv);
  await run(commandName("pnpm"), ["--filter", "@tvic/dal-memory-validation", "test"], testEnv);
  await run(commandName("pnpm"), ["check:public-integrations"], testEnv);
  console.log("Local PostgreSQL, Redis, composite, and public-artifact checks passed.");
} catch (error) {
  process.exitCode = error instanceof Error && "exitCode" in error ? Number(error.exitCode) : 1;
  console.error(
    "Local integration checks failed. The Docker services were left running for inspection.",
  );
}

async function ensureMemoryDatabase() {
  const query = "SELECT 1 FROM pg_database WHERE datname = 'tvic_memory'";
  const result = await runCapture("docker", [
    ...composeArgs,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "tvic",
    "-d",
    "tvic",
    "-tAc",
    query,
  ]);
  if (result.trim() === "1") return;
  await run(
    "docker",
    [
      ...composeArgs,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "tvic",
      "-d",
      "tvic",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "CREATE DATABASE tvic_memory",
    ],
    process.env,
  );
}

function commandName(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`);
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || signal || code}`));
    });
  });
}

function loadLocalEnv() {
  let source;
  try {
    source = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = parseEnvValue(match[2] ?? "");
  }
}

function parseEnvValue(raw) {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  const comment = raw.indexOf(" #");
  return comment >= 0 ? raw.slice(0, comment).trimEnd() : raw;
}
