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
  /^packages\/(?:runtime|voice-runtime|core|tools)\/src(?:\/|$)/,
  /^packages\/[^/]+\/package\.json$/,
  /(?:^|\/)migrations?(?:\/|$)/,
  /^scripts\/(?:check-public-durable-integrations|check-public-durable-artifact|generate-migration-bundles|run-local-integrations)\.mjs$/,
  /^\.github\/workflows\//,
  /^docker-compose\.integration\.yml$/,
  /^docker\/postgres\/init(?:\/|$)/,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^pnpm-lock\.yaml$/,
  /^turbo\.json$/,
  /^tsconfig[^/]*\.json$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /^examples\/live-call\/src\/(?:durable-runtime|gateway|security)\.ts$/,
  /^examples\/live-call\/test\/replay-redis\.test\.ts$/,
  /^examples\/live-call\/package\.json$/,
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
    "--diff-filter=ACMRD",
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

function runPathFixture() {
  const cases = [
    ["docs/README.md", false],
    ["scripts/run-dual-protocol-stress.mjs", false],
    ["scripts/check-local-durable-integration-targets.mjs", false],
    ["packages/providers/src/twilio-provider.ts", false],
    ["packages/media/src/audio-codec.ts", false],
    ["examples/live-call/src/main.ts", false],
    ["packages/dal-postgres/src/idempotency.ts", true],
    ["packages/runtime/src/pipeline-tool-exec.ts", true],
    ["packages/voice-runtime/src/managed-agent.ts", true],
    ["packages/tools/src/idempotency.ts", true],
    ["packages/dal-composite/test/integration.test.ts", true],
    ["examples/live-call/test/replay-redis.test.ts", true],
    ["scripts/check-public-durable-artifact.mjs", true],
    ["docker-compose.integration.yml", true],
    [".github/workflows/ci.yml", true],
  ];
  for (const [filePath, expected] of cases) {
    assert(
      isDurablePath(filePath) === expected,
      `durable routing fixture mismatch for ${filePath}`,
    );
  }
  process.stdout.write("CI routing path fixture ok: durable owners and unrelated paths\n");
}

function assertJobTimeouts(workflow, jobNames, label) {
  for (const jobName of jobNames) {
    const start = workflow.search(new RegExp(`^  ${jobName}:\\s*$`, "m"));
    assert(start >= 0, `${label} workflow is missing ${jobName}`);
    const nextJob = workflow.slice(start + 1).search(/^  [a-z0-9_-]+:\s*$/m);
    const block = workflow.slice(start, nextJob < 0 ? undefined : start + 1 + nextJob);
    assert(/^    timeout-minutes:\s*\d+\s*$/m.test(block), `${jobName} has no job timeout`);
  }
}

async function runFixture() {
  runPathFixture();
  const fixtureHead = (await git("rev-parse", "HEAD")).trim();
  assert(
    !durableRequired(["docs/README.md", "docs/glossary.md"]),
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
    !durableRequired(["docs/maintaining-docs.md"]),
    "documentation-only fixture matched durable",
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
  const releaseWorkflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  const compose = await readFile(
    path.join(repositoryRoot, "docker-compose.integration.yml"),
    "utf8",
  );
  const turbo = JSON.parse(await readFile(path.join(repositoryRoot, "turbo.json"), "utf8"));
  const gateScript = await readFile(
    path.join(repositoryRoot, "scripts/check-ci-gates.mjs"),
    "utf8",
  );
  for (const job of [
    "change_scope",
    "lint",
    "security",
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
  assert(
    /pull_request:\s*\n\s+types:\s*\[[^\]]*labeled[^\]]*unlabeled[^\]]*\]/.test(workflow),
    "pull request CI must rerun when the Merge Ready label is added or removed",
  );
  assert(/workflow_dispatch:\s*\n/.test(workflow), "workflow is missing workflow_dispatch");
  assert(/force_durable:/.test(workflow), "workflow is missing force_durable");
  const security = workflow.slice(
    workflow.indexOf("  security:"),
    workflow.indexOf("  pr_verify:"),
  );
  const prVerify = workflow.slice(
    workflow.indexOf("  pr_verify:"),
    workflow.indexOf("  pr_durable:"),
  );
  const prDurable = workflow.slice(
    workflow.indexOf("  pr_durable:"),
    workflow.indexOf("  main_runtime:"),
  );
  const lint = workflow.slice(workflow.indexOf("  lint:"), workflow.indexOf("  security:"));
  assert(
    /pnpm check:local-integration-targets/.test(lint),
    "CI lint does not run the local integration target guard checks",
  );
  assert(/name:\s*Security/.test(security), "security check name changed");
  assert(
    /pnpm audit --prod --audit-level high/.test(security),
    "security check does not audit production dependency advisories",
  );
  assert(
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'Merge Ready'\)/.test(prVerify) &&
      /github\.event_name == 'merge_group'/.test(prVerify),
    "extended PR verification must run for Merge Ready PRs and merge queue candidates",
  );
  assert(
    /github\.event_name != 'pull_request' \|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'Merge Ready'\)/.test(
      prDurable,
    ),
    "durable PR integrations must wait for Merge Ready while remaining enabled for other CI events",
  );
  for (const image of [
    "postgres:16.15-alpine3.23@sha256:621a761097839bdb50207afd6b87a72f38e2d718dd46c3d744828d8917c4f1e0",
    "redis:7.4.11-alpine3.21@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499",
  ]) {
    assert(compose.includes(image), `local integration Compose does not pin ${image}`);
    assert(workflow.includes(image), `CI does not use the local integration image ${image}`);
    assert(releaseWorkflow.includes(image), `release checks do not use ${image}`);
  }
  for (const source of [workflow, releaseWorkflow]) {
    for (const stepName of [
      "Run public durable artifact test",
      "Check public durable integrations",
      "Run shared TwiML replay test",
      "Verify durable adapters through the exact packed artifact",
    ]) {
      let stepStart = source.indexOf(`- name: ${stepName}`);
      while (stepStart >= 0) {
        const stepEnd = source.indexOf("\n      - ", stepStart + 1);
        const step = source.slice(stepStart, stepEnd < 0 ? undefined : stepEnd);
        assert(
          /TVIC_RUN_INTEGRATION:\s*\"1\"/.test(step),
          `${stepName} does not explicitly enable durable integration checks`,
        );
        stepStart = source.indexOf(
          `- name: ${stepName}`,
          stepEnd < 0 ? source.length : stepEnd + 1,
        );
      }
    }
  }
  assert(
    !/pnpm --filter @tvic\/(?:providers|example-live-call) test/.test(security),
    "security check duplicates package tests instead of scanning dependencies",
  );
  assert(
    /github\.event_name == 'pull_request'/.test(security) &&
      /github\.event_name == 'merge_group'/.test(security) &&
      /github\.event_name == 'push'/.test(security) &&
      /github\.ref == 'refs\/heads\/main'/.test(security) &&
      /github\.event_name == 'workflow_dispatch'/.test(security),
    "security event coverage is incomplete",
  );
  assertJobTimeouts(
    workflow,
    [
      "change_scope",
      "lint",
      "security",
      "pr_verify",
      "pr_durable",
      "main_runtime",
      "main_artifact",
      "main_durable",
      "manual_verify",
      "durable_gate",
      "verify",
    ],
    "CI",
  );
  const durableGate = workflow.slice(
    workflow.indexOf("  durable_gate:"),
    workflow.indexOf("  verify:"),
  );
  assert(
    /actions\/checkout@/u.test(durableGate),
    "durable_gate cannot load its gate evaluator without a checkout",
  );
  assert(/if:\s*\$\{\{\s*always\(\)\s*\}\}/.test(durableGate), "durable_gate is not always-run");
  assert(
    /needs:\s*\[change_scope,\s*pr_durable,\s*main_durable\]/.test(durableGate),
    "durable_gate needs are incomplete",
  );
  assert(
    /check-ci-gates\.mjs --durable/.test(durableGate),
    "durable_gate is not using the tested gate evaluator",
  );
  const verify = workflow.slice(workflow.indexOf("  verify:"));
  assert(/name:\s*Merge Gate/.test(verify), "Merge Gate check name changed");
  assert(/if:\s*\$\{\{\s*always\(\)\s*\}\}/.test(verify), "verify is not always-run");
  assert(
    /actions\/checkout@/u.test(verify),
    "verify cannot load its gate evaluator without a checkout",
  );
  assert(
    /needs:\s*\[lint,\s*security,\s*pr_verify,\s*main_runtime,\s*main_artifact,\s*manual_verify,\s*durable_gate\]/.test(
      verify,
    ),
    "verify needs are incomplete",
  );
  assert(/SECURITY_RESULT:/.test(verify), "Merge Gate does not consume the security result");
  assert(/MERGE_READY:/.test(verify), "Merge Gate does not consume the Merge Ready label");
  assert(
    /check-ci-gates\.mjs --verify/.test(verify),
    "verify is not using the tested gate evaluator",
  );
  assert(
    /evaluateDurableGate/.test(gateScript) &&
      /evaluateVerifyGate/.test(gateScript) &&
      /Merge Ready label is required/.test(gateScript) &&
      /cancelled/.test(gateScript),
    "CI gate evaluator does not cover Merge Ready and cancellation states",
  );
  assert(
    ["TVIC_RUN_INTEGRATION", "DATABASE_URL", "MEMORY_INTEGRATION_URL", "REDIS_URL"].every((name) =>
      turbo.globalEnv?.includes(name),
    ),
    "turbo does not pass integration environment variables to package tests",
  );
  process.stdout.write(
    "CI workflow shape ok: durable_gate and verify are always-run aggregate checks\n",
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.fixture) {
  await runFixture();
} else if (args.path_fixture) {
  runPathFixture();
} else if (args.workflow_shape) {
  await runWorkflowShape();
} else if (args.event) {
  await runScope(args);
} else {
  await runFixture();
  await runWorkflowShape();
}
