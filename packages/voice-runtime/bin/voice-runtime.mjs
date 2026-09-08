#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = path.join(packageRoot, "skills", "tvic", "SKILL.md");

const AGENT_TARGETS = Object.freeze({
  claude: Object.freeze({
    label: "Claude Code",
    relativePath: path.join(".claude", "skills", "tvic", "SKILL.md"),
  }),
  codex: Object.freeze({
    label: "Codex",
    relativePath: path.join(".agents", "skills", "tvic", "SKILL.md"),
  }),
  openrouter: Object.freeze({
    label: "OpenRouter-compatible agents",
    relativePath: path.join(".agents", "skills", "tvic", "SKILL.md"),
  }),
});

const DEFAULT_AGENTS = Object.freeze(["claude", "codex", "openrouter"]);

function printHelp() {
  process.stdout.write("voice-runtime\n\n");
  process.stdout.write("Install the optional TVIC guidance skill in the current project.\n\n");
  process.stdout.write("Usage:\n");
  process.stdout.write("  voice-runtime skills install [options]\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --agent <name>  Target claude, codex, or openrouter. Repeatable.\n");
  process.stdout.write("  --yes           Confirm installation without a prompt.\n");
  process.stdout.write("  --dry-run       Show planned files without changing anything.\n");
  process.stdout.write("  --force         Replace an existing TVIC skill file.\n");
  process.stdout.write("  --help          Show this help.\n\n");
  process.stdout.write("Project paths:\n");
  process.stdout.write("  Claude Code: .claude/skills/tvic/SKILL.md\n");
  process.stdout.write("  Codex/OpenRouter: .agents/skills/tvic/SKILL.md\n");
}

function parseArgs(args) {
  const options = {
    agents: [],
    dryRun: false,
    force: false,
    help: false,
    yes: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--yes" || argument === "-y") {
      options.yes = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--force" || argument === "-f") {
      options.force = true;
      continue;
    }

    if (argument === "--agent") {
      const value = args[index + 1];
      if (!value) throw new Error("--agent requires a value");
      options.agents.push(...value.split(","));
      index += 1;
      continue;
    }

    if (argument.startsWith("--agent=")) {
      options.agents.push(...argument.slice("--agent=".length).split(","));
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

function selectedAgents(requestedAgents) {
  const names = requestedAgents.length > 0 ? requestedAgents : DEFAULT_AGENTS;
  const selected = new Set();

  for (const requested of names) {
    const name = requested.trim().toLowerCase();
    if (name === "all") {
      for (const agent of DEFAULT_AGENTS) selected.add(agent);
      continue;
    }
    if (!Object.hasOwn(AGENT_TARGETS, name)) {
      throw new Error(`Unknown agent "${requested}". Choose claude, codex, or openrouter.`);
    }
    selected.add(name);
  }

  return [...selected];
}

function plannedFiles(agentNames, projectDirectory) {
  const plans = new Map();

  for (const agentName of agentNames) {
    const target = AGENT_TARGETS[agentName];
    const absolutePath = path.resolve(projectDirectory, target.relativePath);
    const existing = plans.get(absolutePath);
    if (existing) {
      existing.agentNames.push(agentName);
    } else {
      plans.set(absolutePath, {
        agentNames: [agentName],
        absolutePath,
        relativePath: path.relative(projectDirectory, absolutePath),
      });
    }
  }

  return [...plans.values()];
}

async function inspectPlans(plans, source, force) {
  const inspected = [];

  for (const plan of plans) {
    let current;
    try {
      current = await readFile(plan.absolutePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    let action = "create";
    if (current !== undefined) {
      action = current === source ? "unchanged" : force ? "replace" : "conflict";
    }
    inspected.push({ ...plan, action });
  }

  return inspected;
}

async function confirmInstallation(projectDirectory, plans) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "No interactive terminal is available. Re-run with --yes to confirm installation.",
    );
  }

  const labels = [...new Set(plans.flatMap((plan) => plan.agentNames))]
    .map((agentName) => AGENT_TARGETS[agentName].label)
    .join(", ");
  const prompt = `Install TVIC guidance for ${labels} in ${projectDirectory}? (y/N) `;
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(prompt);
    return answer.trim().toLowerCase() === "y";
  } finally {
    terminal.close();
  }
}

async function installPlans(plans, source) {
  for (const plan of plans) {
    if (plan.action === "unchanged") {
      process.stdout.write(`Already installed: ${plan.relativePath}\n`);
      continue;
    }
    await mkdir(path.dirname(plan.absolutePath), { recursive: true });
    await writeFile(plan.absolutePath, source, "utf8");
    process.stdout.write(
      `${plan.action === "replace" ? "Updated" : "Installed"}: ${plan.relativePath}\n`,
    );
  }
}

async function installSkills(options) {
  const projectDirectory = process.cwd();
  const agents = selectedAgents(options.agents);
  const source = await readFile(skillSource, "utf8");
  const plans = await inspectPlans(plannedFiles(agents, projectDirectory), source, options.force);

  process.stdout.write(`Project: ${projectDirectory}\n`);
  for (const plan of plans) {
    const agentsForPath = [...new Set(plan.agentNames)]
      .map((agentName) => AGENT_TARGETS[agentName].label)
      .join(" and ");
    process.stdout.write(`  ${plan.relativePath} (${agentsForPath})\n`);
  }

  if (options.dryRun) {
    process.stdout.write("Dry run: no files changed.\n");
    return;
  }

  const conflicts = plans.filter((plan) => plan.action === "conflict");
  if (conflicts.length > 0) {
    throw new Error(
      `Existing TVIC skill files differ: ${conflicts
        .map((plan) => plan.relativePath)
        .join(", ")}. Use --force to replace them.`,
    );
  }

  if (!options.yes && !(await confirmInstallation(projectDirectory, plans))) {
    process.stdout.write("No files changed.\n");
    return;
  }

  await installPlans(plans, source);
  process.stdout.write(
    "TVIC agent guidance is ready. Restart the agent if it does not appear automatically.\n",
  );
}

async function main() {
  const [command, subcommand, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || !command) {
    printHelp();
    return;
  }
  if (command !== "skills" || subcommand !== "install") {
    throw new Error("Use: voice-runtime skills install [options]");
  }

  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return;
  }
  await installSkills(options);
}

main().catch((error) => {
  process.stderr.write(
    `voice-runtime: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
