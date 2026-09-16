import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/release.yml"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /release:\s*\n\s*types:\s*\[published\]/u.test(workflow),
  "release must trigger only on release.published",
);
for (const job of [
  "release_lint",
  "release_security",
  "release_verify",
  "package_artifact",
  "package_compatibility",
  "live_reference",
  "publish",
]) {
  assert(new RegExp(`^  ${job}:\\s*$`, "mu").test(workflow), `release workflow is missing ${job}`);
}
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
assert(/environment:\s*live-provider/u.test(workflow), "live reference is not protected");
assert(
  /REFERENCE_WAV_B64/u.test(workflow),
  "live reference fixture is not protected configuration",
);
assert(
  /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/voice-runtime-artifact/u.test(workflow),
  "release artifact is not uploaded as one stable directory",
);
assert(!/local\//u.test(workflow), "release workflow depends on ignored local files");
assert(
  /needs:\s*\[\s*release_lint,\s*release_security,\s*release_verify,\s*package_artifact,\s*package_compatibility,\s*live_reference,?\s*\]/u.test(
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
  "release workflow shape ok: protected source, exact artifact, live gate, and trusted publish\n",
);
