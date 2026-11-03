import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_CHECK_NAME = "Merge Gate";
export const REQUIRED_APP_ID = 15368;

export function selectReleaseCheckRun(checkRuns, expectedSha) {
  const matchingRuns = (Array.isArray(checkRuns) ? checkRuns : []).filter(
    (check) =>
      check?.name === REQUIRED_CHECK_NAME &&
      check?.head_sha === expectedSha &&
      check?.app?.id === REQUIRED_APP_ID,
  );

  const invalidId = matchingRuns.find((check) => !Number.isSafeInteger(check.id) || check.id <= 0);
  if (invalidId) {
    return { ok: false, matchingRuns, selectedRun: null, reason: "invalid check-run ID" };
  }

  const selectedRun = matchingRuns.reduce(
    (latest, check) => (!latest || check.id > latest.id ? check : latest),
    null,
  );
  const ok = selectedRun?.status === "completed" && selectedRun.conclusion === "success";

  return {
    ok,
    matchingRuns,
    selectedRun,
    reason: ok ? null : "the newest matching check run is not completed successfully",
  };
}

export function formatSelectionFailure(result, expectedSha) {
  const details = result.matchingRuns.length
    ? result.matchingRuns
        .map(
          (check) =>
            `  id=${String(check.id ?? "unknown")} status=${String(check.status ?? "unknown")} conclusion=${String(check.conclusion ?? "none")}`,
        )
        .join("\n")
    : "  (no matching runs found)";

  return [
    `${REQUIRED_CHECK_NAME} has not passed for ${expectedSha}: ${result.reason}`,
    `Matching runs (name, app ID, and SHA):\n${details}`,
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeRun(id, overrides = {}) {
  return {
    id,
    name: REQUIRED_CHECK_NAME,
    head_sha: "expected-sha",
    app: { id: REQUIRED_APP_ID },
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

export function runFixture() {
  const olderSuccess = makeRun(100);
  const newerFailure = makeRun(101, { conclusion: "failure" });
  for (const checkRuns of [
    [olderSuccess, newerFailure],
    [newerFailure, olderSuccess],
  ]) {
    const result = selectReleaseCheckRun(checkRuns, "expected-sha");
    assert(!result.ok, "a newer failure must not be masked by an older successful run");
    assert(result.selectedRun?.id === 101, "the greatest matching check-run ID must be selected");
    const diagnostic = formatSelectionFailure(result, "expected-sha");
    assert(
      diagnostic.includes("id=100 status=completed conclusion=success"),
      "older run missing from diagnostics",
    );
    assert(
      diagnostic.includes("id=101 status=completed conclusion=failure"),
      "newer run missing from diagnostics",
    );
  }

  const reversedSuccesses = selectReleaseCheckRun([makeRun(205), makeRun(204)], "expected-sha");
  assert(reversedSuccesses.ok, "a successful newest matching run should pass");
  assert(reversedSuccesses.selectedRun?.id === 205, "response order must not choose the run");

  assert(
    !selectReleaseCheckRun([makeRun(300, { head_sha: "other-sha" })], "expected-sha").ok,
    "a check run for another SHA must not pass",
  );
  assert(
    !selectReleaseCheckRun([makeRun(301, { app: { id: 1 } })], "expected-sha").ok,
    "a check run from another app must not pass",
  );
  assert(
    !selectReleaseCheckRun(
      [makeRun(302, { status: "in_progress", conclusion: null })],
      "expected-sha",
    ).ok,
    "an incomplete check run must not pass",
  );

  const noMatch = selectReleaseCheckRun([], "expected-sha");
  assert(!noMatch.ok && noMatch.matchingRuns.length === 0, "an absent check run must fail");
  assert(
    formatSelectionFailure(noMatch, "expected-sha").includes("(no matching runs found)"),
    "a missing check run must have an explicit diagnostic",
  );

  process.stdout.write(
    "release check selector fixtures ok: exact identity and newest-run result\n",
  );
}

async function selectFromFile(checkRunsPath, expectedSha) {
  const payload = JSON.parse(await readFile(path.resolve(checkRunsPath), "utf8"));
  const result = selectReleaseCheckRun(payload?.check_runs, expectedSha);
  if (!result.ok) {
    process.stderr.write(`::error::${formatSelectionFailure(result, expectedSha)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${REQUIRED_CHECK_NAME} passed for ${expectedSha} (check run ${result.selectedRun.id})\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === "--fixture") {
    runFixture();
  } else if (args.length === 2) {
    await selectFromFile(args[0], args[1]);
  } else {
    throw new Error(
      "Usage: node scripts/release-check-selector.mjs --fixture|<check-runs-json> <sha>",
    );
  }
}
