import { appendFile } from "node:fs/promises";

function failure(reason) {
  return { ok: false, reason };
}

function success(status = "required") {
  return { ok: true, status };
}

function requireResult(name, actual) {
  return actual === "success"
    ? success()
    : failure(`${name} must be success, received ${String(actual)}`);
}

function requireSkipped(name, actual) {
  return actual === "skipped"
    ? success("not_applicable")
    : failure(`${name} must be skipped when inapplicable, received ${String(actual)}`);
}

/**
 * Evaluates the durable branch of CI. A job that is not applicable must be
 * skipped, not failed or cancelled, so an unexpected dependency state cannot
 * disappear behind a successful aggregate.
 */
export function evaluateDurableGate({ event, scopeResult, durableRequired, prResult, mainResult }) {
  if (scopeResult !== "success") {
    return failure(`change_scope must be success, received ${String(scopeResult)}`);
  }
  if (durableRequired !== "true" && durableRequired !== "false") {
    return failure(`durable_required must be true or false, received ${String(durableRequired)}`);
  }

  switch (event) {
    case "pull_request":
    case "merge_group":
      if (mainResult !== "skipped") {
        return failure(`main_durable must be skipped for ${event}, received ${String(mainResult)}`);
      }
      return durableRequired === "true"
        ? requireResult("pr_durable", prResult)
        : requireSkipped("pr_durable", prResult);
    case "push":
      if (durableRequired !== "true") {
        return failure("durable_required must be true for a main push");
      }
      if (prResult !== "skipped") {
        return failure(`pr_durable must be skipped for push, received ${String(prResult)}`);
      }
      return requireResult("main_durable", mainResult);
    case "workflow_dispatch":
      if (mainResult !== "skipped") {
        return failure(
          `main_durable must be skipped for workflow_dispatch, received ${String(mainResult)}`,
        );
      }
      return durableRequired === "true"
        ? requireResult("pr_durable", prResult)
        : requireSkipped("pr_durable", prResult);
    default:
      return failure(`unsupported event: ${String(event)}`);
  }
}

/** Evaluates the single displayed branch-protection check. */
export function evaluateVerifyGate({
  event,
  lintResult,
  securityResult,
  durableGateResult,
  prResult,
  mainRuntimeResult,
  mainArtifactResult,
  manualResult,
}) {
  for (const [name, result] of [
    ["lint", lintResult],
    ["security", securityResult],
    ["durable_gate", durableGateResult],
  ]) {
    if (result !== "success") return failure(`${name} must be success, received ${String(result)}`);
  }

  switch (event) {
    case "pull_request":
    case "merge_group":
      if (mainRuntimeResult !== "skipped" || mainArtifactResult !== "skipped") {
        return failure("main-only jobs must be skipped for pull_request and merge_group");
      }
      if (manualResult !== "skipped") {
        return failure(
          `manual_verify must be skipped for ${event}, received ${String(manualResult)}`,
        );
      }
      return requireResult("pr_verify", prResult);
    case "push":
      if (prResult !== "skipped" || manualResult !== "skipped") {
        return failure("PR and manual jobs must be skipped for a main push");
      }
      if (mainRuntimeResult !== "success") {
        return failure(`main_runtime must be success, received ${String(mainRuntimeResult)}`);
      }
      return requireResult("main_artifact", mainArtifactResult);
    case "workflow_dispatch":
      if (
        prResult !== "skipped" ||
        mainRuntimeResult !== "skipped" ||
        mainArtifactResult !== "skipped"
      ) {
        return failure("PR and main-only jobs must be skipped for workflow_dispatch");
      }
      return requireResult("manual_verify", manualResult);
    default:
      return failure(`unsupported event: ${String(event)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseVerify(event) {
  return {
    event,
    lintResult: "success",
    securityResult: "success",
    durableGateResult: "success",
    prResult: "skipped",
    mainRuntimeResult: "skipped",
    mainArtifactResult: "skipped",
    manualResult: "skipped",
  };
}

function baseDurable(event, durableRequired = "false") {
  return {
    event,
    scopeResult: "success",
    durableRequired,
    prResult: "skipped",
    mainResult: "skipped",
  };
}

export function runFixture() {
  assert(
    evaluateDurableGate(baseDurable("pull_request")).ok,
    "docs-only pull request durable gate should pass as not applicable",
  );
  assert(
    evaluateDurableGate(baseDurable("pull_request", "true")).ok === false,
    "required durable pull request must not pass when its job is skipped",
  );
  assert(
    evaluateDurableGate({ ...baseDurable("pull_request", "true"), prResult: "success" }).ok,
    "required durable pull request should pass",
  );
  assert(
    evaluateDurableGate({ ...baseDurable("pull_request"), prResult: "cancelled" }).ok === false,
    "cancelled inapplicable durable job must not pass",
  );
  assert(
    evaluateDurableGate({ ...baseDurable("push", "true"), mainResult: "success" }).ok,
    "main push durable gate should require main durable",
  );
  assert(
    evaluateDurableGate({ ...baseDurable("workflow_dispatch", "true"), prResult: "success" }).ok,
    "forced manual durable gate should require PR durable",
  );
  assert(
    evaluateDurableGate({ ...baseDurable("push", "true"), mainResult: "cancelled" }).ok === false,
    "cancelled main durable job must fail the durable gate",
  );

  assert(
    evaluateVerifyGate({
      ...baseVerify("pull_request"),
      prResult: "success",
    }).ok,
    "pull request Verify should pass with only PR jobs active",
  );
  assert(
    evaluateVerifyGate({
      ...baseVerify("push"),
      mainRuntimeResult: "success",
      mainArtifactResult: "success",
    }).ok,
    "main Verify should require runtime and artifact jobs",
  );
  assert(
    evaluateVerifyGate({ ...baseVerify("workflow_dispatch"), manualResult: "success" }).ok,
    "manual Verify should require manual verification",
  );
  for (const field of ["lintResult", "securityResult", "durableGateResult"]) {
    assert(
      evaluateVerifyGate({
        ...baseVerify("pull_request"),
        prResult: "success",
        [field]: "cancelled",
      }).ok === false,
      `cancelled ${field} must fail Verify`,
    );
  }
  assert(
    evaluateVerifyGate({ ...baseVerify("pull_request"), prResult: "failure" }).ok === false,
    "failed PR verification must fail Verify",
  );
  assert(
    evaluateVerifyGate({
      ...baseVerify("push"),
      mainRuntimeResult: "cancelled",
      mainArtifactResult: "success",
    }).ok === false,
    "cancelled main runtime must fail Verify",
  );
  assert(
    evaluateVerifyGate({ ...baseVerify("workflow_dispatch"), manualResult: "cancelled" }).ok ===
      false,
    "cancelled manual verification must fail Verify",
  );
  assert(
    evaluateVerifyGate({
      ...baseVerify("pull_request"),
      prResult: "success",
      manualResult: "cancelled",
    }).ok === false,
    "an unexpectedly cancelled inapplicable job must fail Verify",
  );
  process.stdout.write("CI gate fixture ok: applicable, skipped, failed, and cancelled states\n");
}

async function runFromEnvironment(mode) {
  const result =
    mode === "durable"
      ? evaluateDurableGate({
          event: process.env.EVENT_NAME,
          scopeResult: process.env.SCOPE_RESULT,
          durableRequired: process.env.DURABLE_REQUIRED,
          prResult: process.env.PR_RESULT,
          mainResult: process.env.MAIN_RESULT,
        })
      : evaluateVerifyGate({
          event: process.env.EVENT_NAME,
          lintResult: process.env.LINT_RESULT,
          securityResult: process.env.SECURITY_RESULT,
          durableGateResult: process.env.DURABLE_GATE_RESULT,
          prResult: process.env.PR_RESULT,
          mainRuntimeResult: process.env.MAIN_RUNTIME_RESULT,
          mainArtifactResult: process.env.MAIN_ARTIFACT_RESULT,
          manualResult: process.env.MANUAL_RESULT,
        });
  if (!result.ok) throw new Error(result.reason);
  const status = result.status ?? "success";
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `status=${status}\n`);
  process.stdout.write(`CI ${mode} gate passed: ${status}\n`);
}

if (process.argv.includes("--fixture")) {
  runFixture();
} else if (process.argv.includes("--durable")) {
  await runFromEnvironment("durable");
} else if (process.argv.includes("--verify")) {
  await runFromEnvironment("verify");
} else {
  throw new Error("Usage: node scripts/check-ci-gates.mjs --fixture|--durable|--verify");
}
