import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
const compose = await readFile(path.join(repositoryRoot, "docker-compose.integration.yml"), "utf8");

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
assert(
  /registry\.npmjs\.org[\s\S]*already published/u.test(workflow),
  "release does not reject an existing npm version",
);
assert(/APPROVED_RELEASE_SHA/u.test(workflow), "release source lacks an explicit approved SHA");
assert(
  /TAG_SHA/u.test(workflow) && /MAIN_SHA/u.test(workflow),
  "release does not compare tag and main SHAs",
);
assert(
  /check-runs\?per_page=100/u.test(workflow),
  "release does not verify the exact Verify check run",
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
