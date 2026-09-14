import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const durablePathPatterns = [
  /^packages\/dal(?:\/|$)/,
  /^packages\/dal-[^/]+(?:\/|$)/,
  /^packages\/(?:runtime|voice-runtime|core|media|providers|tools)(?:\/|$)/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/[^/]+\/.*(?:^|\/)migrations?(?:\/|$)/,
  /^scripts\//,
  /^\.github\/workflows\//,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^pnpm-lock\.yaml$/,
  /^turbo\.json$/,
  /^tsconfig[^/]*\.json$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)migrations?(?:\/|$)/,
  /^examples\/(?:live-call|voice-mode|memory-demo)(?:\/|$)/,
];

function normalizePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`invalid changed path: ${value}`);
  }
  return normalized;
}

export function isDurablePath(value) {
  const normalized = normalizePath(value);
  return durablePathPatterns.some((pattern) => pattern.test(normalized));
}

export function durableRequired(paths) {
  return paths.some((value) => isDurablePath(value));
}

function sha(value, label, { allowZero = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  if (allowZero && /^0+$/.test(value)) return null;
  if (!/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new Error(`${label} is not a commit SHA: ${value}`);
  }
  return value;
}

async function git(...args) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repositoryRoot,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

async function verifyCommit(value, label) {
  const candidate = sha(value, label);
  const resolved = (await git("rev-parse", "--verify", `${candidate}^{commit}`)).trim();
  if (!/^[0-9a-f]{40}$/i.test(resolved)) {
    throw new Error(`${label} could not be resolved to a commit: ${value}`);
  }
  return resolved;
}

async function parentOf(head) {
  try {
    return await verifyCommit(
      (await git("rev-parse", "--verify", `${head}^`)).trim(),
      "dispatch parent",
    );
  } catch (error) {
    const roots = (await git("rev-list", "--max-parents=0", "--all"))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (roots.includes(head)) return null;
    throw new Error(`dispatch parent could not be resolved for ${head}: ${String(error)}`);
  }
}

export async function selectBase({ event, head, pullRequestBase, mergeGroupBase, pushBefore }) {
  switch (event) {
    case "pull_request":
      return verifyCommit(sha(pullRequestBase, "pull_request.base.sha"), "pull_request.base.sha");
    case "merge_group":
      return verifyCommit(sha(mergeGroupBase, "merge_group.base_sha"), "merge_group.base_sha");
    case "push": {
      const before = sha(pushBefore, "push.before", { allowZero: true });
      return before === null ? EMPTY_TREE : verifyCommit(before, "push.before");
    }
    case "workflow_dispatch":
      return parentOf(await verifyCommit(head, "github.sha"));
    default:
      throw new Error(`unsupported CI event: ${String(event)}`);
  }
}

async function changedPaths(base, head) {
  const output = await git(
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
    base ?? EMPTY_TREE,
    head,
    "--",
  );
  return output.split("\0").filter(Boolean).map(normalizePath);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const [key, inlineValue] = argument.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      result[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

async function runScope(args) {
  const event = String(args.event ?? "");
  const head = await verifyCommit(args.head, "github.sha");
  let required;
  let paths = [];
  if (event === "push") {
    required = true;
  } else if (event === "workflow_dispatch") {
    if (args.force_durable !== "true" && args.force_durable !== "false") {
      throw new Error("workflow_dispatch force_durable must be true or false");
    }
    required = args.force_durable === "true";
  } else {
    const base = await selectBase({
      event,
      head,
      pullRequestBase: args.pull_request_base,
      mergeGroupBase: args.merge_group_base,
      pushBefore: args.push_before,
    });
    paths = await changedPaths(base, head);
    required = durableRequired(paths);
  }
  const output = `durable_required=${required ? "true" : "false"}\n`;
  if (args.output) {
    await appendFile(args.output, output);
  }
  process.stdout.write(
    `CI scope ok: event=${event}, durable_required=${required ? "true" : "false"}, changed_paths=${paths.length}\n`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runFixture() {
  const fixtureHead = (await git("rev-parse", "HEAD")).trim();
  assert(
    !durableRequired(["docs/start-here.md", "docs/glossary.md"]),
    "docs-only fixture matched durable",
  );
  assert(durableRequired(["packages/dal/src/index.ts"]), "DAL fixture did not match durable");
  assert(
    durableRequired(["packages/dal-postgres/src/idempotency.ts"]),
    "DAL adapter fixture did not match durable",
  );
  assert(
    durableRequired(["packages/voice-runtime/src/index.ts"]),
    "voice-runtime fixture did not match durable",
  );
  assert(
    durableRequired(["examples/live-call/src/gateway.ts"]),
    "persistence example fixture did not match durable",
  );
  assert(
    !durableRequired(["docs/decisions/1.1.0-public-api.md"]),
    "decision-only fixture matched durable",
  );
  assert(
    (await selectBase({
      event: "pull_request",
      pullRequestBase: fixtureHead,
    })) === fixtureHead,
    "pull request base fixture changed",
  );
  assert(
    (await selectBase({
      event: "merge_group",
      mergeGroupBase: fixtureHead,
    })) === fixtureHead,
    "merge group base fixture changed",
  );
  let missingBaseRejected = false;
  try {
    await selectBase({ event: "pull_request" });
  } catch {
    missingBaseRejected = true;
  }
  assert(missingBaseRejected, "missing base did not reject");
  process.stdout.write("CI routing fixture ok: docs-only, durable paths, and base selection\n");
}

async function runWorkflowShape() {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  for (const job of [
    "change_scope",
    "lint",
    "pr_verify",
    "pr_durable",
    "main_runtime",
    "main_artifact",
    "main_durable",
    "manual_verify",
    "durable_gate",
    "verify",
  ]) {
    assert(new RegExp(`^  ${job}:\\s*$`, "m").test(workflow), `workflow is missing ${job}`);
  }
  assert(/merge_group:\s*\n/.test(workflow), "workflow is missing merge_group");
  assert(/workflow_dispatch:\s*\n/.test(workflow), "workflow is missing workflow_dispatch");
  assert(/force_durable:/.test(workflow), "workflow is missing force_durable");
  const durableGate = workflow.slice(
    workflow.indexOf("  durable_gate:"),
    workflow.indexOf("  verify:"),
  );
  assert(/if:\s*\$\{\{\s*always\(\)\s*\}\}/.test(durableGate), "durable_gate is not always-run");
  assert(
    /needs:\s*\[change_scope,\s*pr_durable,\s*main_durable\]/.test(durableGate),
    "durable_gate needs are incomplete",
  );
  const verify = workflow.slice(workflow.indexOf("  verify:"));
  assert(/if:\s*\$\{\{\s*always\(\)\s*\}\}/.test(verify), "verify is not always-run");
  assert(
    /needs:\s*\[lint,\s*pr_verify,\s*main_runtime,\s*main_artifact,\s*manual_verify,\s*durable_gate\]/.test(
      verify,
    ),
    "verify needs are incomplete",
  );
  process.stdout.write(
    "CI workflow shape ok: durable_gate and verify are always-run aggregate checks\n",
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.fixture) {
  await runFixture();
} else if (args.workflow_shape) {
  await runWorkflowShape();
} else if (args.event) {
  await runScope(args);
} else {
  await runFixture();
  await runWorkflowShape();
}
