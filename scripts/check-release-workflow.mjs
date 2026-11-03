import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const compose = await readFile(path.join(repositoryRoot, "docker-compose.integration.yml"), "utf8");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const selector = await readFile(
  path.join(repositoryRoot, "scripts/release-check-selector.mjs"),
  "utf8",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /release:\s*\n\s*types:\s*\[published\]/u.test(workflow),
  "release must trigger only on release.published",
);
const releaseJobs = [
  "release_lint",
  "release_security",
  "release_verify",
  "package_artifact",
  "package_compatibility",
  "publish",
];
for (const job of releaseJobs) {
  assert(new RegExp(`^  ${job}:\\s*$`, "mu").test(workflow), `release workflow is missing ${job}`);
}
for (const job of releaseJobs) {
  const start = workflow.search(new RegExp(`^  ${job}:\\s*$`, "m"));
  const nextJob = workflow.slice(start + 1).search(/^  [a-z0-9_-]+:\s*$/m);
  const block = workflow.slice(start, nextJob < 0 ? undefined : start + 1 + nextJob);
  assert(/^    timeout-minutes:\s*\d+\s*$/m.test(block), `${job} has no job timeout`);
}
const securityJob = workflow.slice(
  workflow.indexOf("  release_security:"),
  workflow.indexOf("  package_artifact:"),
);
assert(
  /pnpm audit --prod --audit-level high/u.test(securityJob),
  "release security job does not audit production dependency advisories",
);
for (const image of [
  "postgres:16.15-alpine3.23@sha256:621a761097839bdb50207afd6b87a72f38e2d718dd46c3d744828d8917c4f1e0",
  "redis:7.4.11-alpine3.21@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499",
]) {
  assert(
    compose.includes(image) && workflow.includes(image),
    `release services are not pinned to ${image}`,
  );
}
assert(
  !/pnpm --filter @tvic\/(?:providers|example-live-call) test/u.test(securityJob),
  "release security job duplicates package tests instead of scanning dependencies",
);
assert(
  /environment:\s*npm-publish/u.test(workflow),
  "publish is missing the protected npm-publish environment",
);
assert(/actions\/upload-artifact@/u.test(workflow), "release artifact is not uploaded");
assert(
  /actions\/download-artifact@/u.test(workflow),
  "publish does not download the tested artifact",
);
assert(/sha256sum/u.test(workflow), "release artifact digest is not recorded");
assert(/--tarball/u.test(workflow), "consumer verification does not receive the exact tarball");
const packageArtifactStart = workflow.indexOf("  package_artifact:");
const packageCompatibilityStart = workflow.indexOf("  package_compatibility:");
assert(
  packageArtifactStart >= 0 && packageCompatibilityStart > packageArtifactStart,
  "release package-artifact source check is missing",
);
const sourceVerification = workflow.slice(packageArtifactStart, packageCompatibilityStart);
assert(
  /registry\.npmjs\.org[\s\S]*already published/u.test(sourceVerification),
  "release does not reject an existing npm version",
);
assert(/APPROVED_RELEASE_SHA/u.test(workflow), "release source lacks an explicit approved SHA");
assert(
  /TAG_SHA/u.test(workflow) && /MAIN_SHA/u.test(workflow),
  "release does not compare tag and main SHAs",
);
assert(
  /check-runs\?check_name=Merge%20Gate&app_id=15368&filter=all&per_page=100/u.test(
    sourceVerification,
  ),
  "release does not request every Merge Gate run from the expected GitHub Actions app",
);
assert(
  /node scripts\/release-check-selector\.mjs "\$CHECKS_JSON" "\$TAG_SHA"/u.test(sourceVerification),
  "release does not run the tested release check selector against the tag SHA",
);
assert(
  !/check-runs\?filter=latest/u.test(sourceVerification),
  "release relies on GitHub's default latest-check filtering",
);
assert(
  /check\?\.name === REQUIRED_CHECK_NAME/u.test(selector) &&
    /check\?\.head_sha === expectedSha/u.test(selector) &&
    /check\?\.app\?\.id === REQUIRED_APP_ID/u.test(selector) &&
    /REQUIRED_APP_ID = 15368/u.test(selector),
  "release selector does not require the exact check name, SHA, and GitHub Actions app ID",
);
assert(
  /check\.id > latest\.id/u.test(selector) &&
    /selectedRun\?\.status === "completed"/u.test(selector) &&
    /selectedRun\.conclusion === "success"/u.test(selector),
  "release selector does not choose the greatest run ID and require its successful completion",
);
assert(
  /export function runFixture/u.test(selector) &&
    /newer failure must not be masked by an older successful run/u.test(selector),
  "release selector is missing the regression fixture for a newer failed run",
);
const verifyJobStart = ciWorkflow.search(/^  verify:\s*$/mu);
assert(verifyJobStart >= 0, "CI workflow is missing the verify job");
const verifyJob = ciWorkflow.slice(verifyJobStart);
const nextJob = verifyJob.slice(1).search(/^  [a-z0-9_-]+:\s*$/mu);
const verifyJobBlock = nextJob < 0 ? verifyJob : verifyJob.slice(0, nextJob + 1);
const ciCheckNameMatch = /^    name:\s*(.*?)\s*$/mu.exec(verifyJobBlock);
const ciCheckName = ciCheckNameMatch?.[1]?.replace(/^(?:"([^"]+)"|'([^']+)')$/u, "$1$2");
assert(ciCheckName, "CI verify job has no static check display name");
const releaseCheckNameMatch = /REQUIRED_CHECK_NAME = ["']([^"']+)["']/u.exec(selector);
assert(releaseCheckNameMatch, "release selector does not declare its required CI check name");
assert(
  releaseCheckNameMatch[1] === ciCheckName,
  `release check name ${releaseCheckNameMatch[1]} does not match CI verify job name ${ciCheckName}`,
);
const lintJobStart = ciWorkflow.search(/^  lint:\s*$/mu);
assert(lintJobStart >= 0, "CI workflow is missing the lint job");
const lintJob = ciWorkflow.slice(lintJobStart);
const nextLintJob = lintJob.slice(1).search(/^  [a-z0-9_-]+:\s*$/mu);
const lintJobBlock = nextLintJob < 0 ? lintJob : lintJob.slice(0, nextLintJob + 1);
assert(
  /pnpm check:release-selector/u.test(lintJobBlock),
  "CI lint does not run release selector fixtures",
);
assert(
  /pnpm check:release-workflow/u.test(lintJobBlock),
  "CI lint does not run release workflow checks",
);
assert(
  packageJson.scripts?.["check:release-selector"] ===
    "node scripts/release-check-selector.mjs --fixture",
  "release selector fixture command is missing from package scripts",
);
assert(
  /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/voice-runtime-artifact/u.test(workflow),
  "release artifact is not uploaded as one stable directory",
);
assert(!/local\//u.test(workflow), "release workflow depends on ignored local files");
assert(
  /needs:\s*\[\s*release_lint,\s*release_security,\s*release_verify,\s*package_artifact,\s*package_compatibility,?\s*\]/u.test(
    workflow,
  ),
  "publish dependencies are incomplete",
);
assert(/NPM_CONFIG_PROVENANCE:\s*true/u.test(workflow), "npm provenance is disabled");
assert(/id-token:\s*write/u.test(workflow), "npm trusted publishing lacks an OIDC permission");
assert(
  !/git\s+(?:commit|push|tag)\b/u.test(workflow),
  "release workflow mutates the git repository",
);
assert(!/gh\s+release\b/u.test(workflow), "release workflow creates GitHub Releases");
const publishCommands = workflow.match(/npm publish\b/gu) ?? [];
assert(publishCommands.length === 1, "release workflow must have exactly one publish command");
assert(
  /npm publish\s+[^\n]+--access public/u.test(workflow),
  "publish command is missing public access",
);
const publishJob = workflow.slice(workflow.indexOf("  publish:"));
assert(!/pnpm\s+(?:build|install)/u.test(publishJob), "publish rebuilds or installs the workspace");

process.stdout.write(
  "release workflow shape ok: protected source, exact artifact, and trusted publish\n",
);
