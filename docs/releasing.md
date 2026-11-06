# Releasing `voice-runtime`

The `npm release` workflow publishes `voice-runtime` after a GitHub Release is
published. The Releases tab is the release control surface. Actions does not
change `main`, create a branch, create a tag, or create a GitHub Release.

User-facing changes belong in the [changelog](../CHANGELOG.md). Provider smoke
commands and evidence requirements are in the [testing guide](./testing.md).

## Before a release

1. Change `packages/voice-runtime/package.json` to the new version in a normal
   pull request.
2. Add the `Merge Ready` label, wait for the required `Merge Gate` check, and
   merge the pull request into `main`. The release requires a successful GitHub
   Actions `Merge Gate` check run on that exact `main` commit.
3. Confirm that the package version has not already been published to npm.
4. Set the repository variable `RELEASE_APPROVED_SHA` to the full SHA of the
   exact protected `main` commit that will be released.
5. Verify the `npm-publish` environment requires maintainer approval and
   restricts deployments to tags matching `voice-runtime-v*`.
6. Confirm that npm trusted publishing points to repository `Kkartik14/TVIC`,
   workflow file `release.yml`, job `publish`, and environment `npm-publish`.

The npm registry reported `voice-runtime@2.1.0` as the latest published version
on 2026-10-26. Verify that the target version is still unused immediately before
release. The package version and release tag must always match. For a release
using version `X.Y.Z`:

```text
packages/voice-runtime/package.json  ->  "version": "X.Y.Z"
GitHub tag                            ->  voice-runtime-vX.Y.Z
```

The 2.2.0 provider and validation changes affect some callers. Read the
[2.2.0 upgrade guide](./migrations/2.2.0.md) before approving the release.
For custom durable-store or idempotency-store adapters, also read the
[2.0.0 migration guide](./migrations/2.0.0.md), especially the method changes
and PostgreSQL writer drains required before migrations 014 and 018.

## Publish from GitHub

1. Open the repository's **Releases** tab.
2. Select **Draft a new release**.
3. Set the target to the intended `main` commit.
4. Create or select a tag shaped `voice-runtime-v<version>`.
5. Enter the release title and notes.
6. Keep **Set as a pre-release** unchecked for the stable npm channel.
7. Select **Publish release**.

Publishing the release emits the `release.published` event and starts the
`npm release` workflow. The tag must be on the same protected `main` commit as
`RELEASE_APPROVED_SHA`.

## What the workflow verifies

The workflow checks out the exact release tag and then:

- runs static, security, deterministic, PostgreSQL, and Redis gates;
- checks the tag SHA, approved SHA, protected `main` tip, and selects the
  matching GitHub Actions `Merge Gate` run with the greatest run ID for the
  exact commit; that run must be completed successfully;
- builds one package tarball and records its manifest, tool versions, and
  SHA-256 digest;
- verifies package exports, ESM, CommonJS, TypeScript, and durable adapters
  from that exact tarball in a clean consumer project;
- rejects an npm version that already exists;
- downloads and publishes the previously verified tarball with npm trusted
  publishing and provenance.

The workflow does not run `git commit`, `git push`, `git tag`, or
`gh release create`.

## If the workflow fails

If npm reports that the version already exists, do not attempt to publish it
again. Verify the package page and provenance, then treat the npm version as
immutable and investigate only the missing release evidence.

If a release check fails before publishing and the npm version is still unused,
delete the GitHub Release and its tag. Fix the cause in a pull request and merge
it to `main`, update `RELEASE_APPROVED_SHA` to that new `main` commit, then
recreate the `voice-runtime-vX.Y.Z` tag on that commit and publish a new GitHub
Release. The workflow checks the tag against both the approved SHA and the
current `main` tip, so rerunning a release for the old tag cannot use a fix that
was merged later.

## Required GitHub configuration

The repository ruleset for `main` must require the single status check
`Merge Gate` from GitHub Actions. Do not require event-specific jobs such as
`main_runtime` on pull requests, because those jobs are intentionally skipped
there.

The `npm-publish` environment must require maintainer approval and restrict
deployments to tags matching `voice-runtime-v*`. The workflow references this
environment but does not inspect its protection rules; without required
reviewers, GitHub will not hold the publish job for approval. Verify the
environment settings in GitHub before each release. Configure npm's trusted
publisher to use the same repository, workflow, job, and environment.

## Trusted publishing configuration

The workflow filename must remain `release.yml` unless the npm trusted-publisher
configuration is updated at the same time. The `publish` job needs an OIDC token
and does not use a long-lived npm token in repository secrets.

Keep release permissions limited to maintainers. Repository and branch settings
control who can merge the version bump, approve `npm-publish`, set the approved
SHA, and publish a GitHub Release.

Credentialed provider smoke tests remain optional manual checks. They are
documented in the [testing guide](./testing.md) and do not block npm publication.

For each release, keep a version-specific record with the actual tag SHA,
`Merge Gate` run URL, artifact filename and digest, publish result, and known
limitations. Never put credentials, raw audio, or full transcripts in a release
record.
