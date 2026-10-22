# Releasing `voice-runtime`

The `npm release` workflow publishes `voice-runtime` after a GitHub Release is
published. The Releases tab is the release control surface. Actions does not
change `main`, create a branch, create a tag, or create a GitHub Release.

User-facing changes belong in the [changelog](../CHANGELOG.md). Provider smoke
commands and evidence requirements are in the [testing guide](./testing.md).

## Before a release

1. Change `packages/voice-runtime/package.json` to the new version in a normal
   pull request.
2. Wait for the required `Verify` check and merge the pull request into `main`.
3. Confirm that the package version has not already been published to npm.
4. Set the repository variable `RELEASE_APPROVED_SHA` to the full SHA of the
   exact protected `main` commit that will be released.
5. Confirm that the `npm-publish` environment is maintainer-only.
6. Confirm that npm trusted publishing points to repository `Kkartik14/TVIC`,
   workflow file `release.yml`, job `publish`, and environment `npm-publish`.

The npm registry reported `voice-runtime@2.0.0` as the latest published version
on 2026-10-21. Verify that `2.1.0` remains unused immediately before release.
The package version and release tag must always match. For a release using
version `X.Y.Z`:

The durable-store and tool-idempotency API changes in 2.0.0 were
source-incompatible for custom adapters. Version 2.0.0 is therefore a major
release under Semantic Versioning. Read the [2.0.0 migration guide](./migrations/2.0.0.md)
before approving the release, especially the method changes and PostgreSQL
writer drains required before migrations 014 and 018.

```text
packages/voice-runtime/package.json  ->  "version": "X.Y.Z"
GitHub tag                            ->  voice-runtime-vX.Y.Z
```

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
- checks the tag SHA, approved SHA, protected `main` tip, and the successful
  `Verify` check for the exact commit;
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

Do not create a second tag or release with the same version. Open the failed
workflow run, fix the reported issue in a pull request, and rerun the failed
job when the fix is available.

If npm reports that the version already exists, do not attempt to publish it
again. Verify the package page and provenance, then treat the npm version as
immutable and investigate only the missing release evidence.

## Required GitHub configuration

The repository should require the single displayed branch-protection check
`Verify`. Do not require event-specific jobs such as `main_runtime` on pull
requests, because those jobs are intentionally skipped there.

Create an `npm-publish` environment with maintainer approval. Configure npm's
trusted publisher to use the same repository, workflow, job, and environment.
If any of these settings are missing, the release is supposed to fail before
publishing.

## Trusted publishing configuration

The workflow filename must remain `release.yml` unless the npm trusted-publisher
configuration is updated at the same time. The `publish` job needs an OIDC token
and does not use a long-lived npm token in repository secrets.

Keep release permissions limited to maintainers. Repository and branch settings
control who can merge the version bump, approve `npm-publish`, set the approved
SHA, and publish a GitHub Release.

Credentialed provider smoke tests remain optional manual checks. They are
documented in the [testing guide](./testing.md) and do not block npm publication.

## Release evidence

The npm registry reported `voice-runtime@2.0.0` as the latest published version
on 2026-10-21. The tracked [1.2.0 GitHub release](https://github.com/Kkartik14/TVIC/releases/tag/voice-runtime-v1.2.0)
contains the earlier public release notes. The repository no longer tracks the
1.1.0 evidence files, and no 1.2.0 workflow-artifact acceptance record is
tracked. For each future release, maintain a version-specific record with the
actual tag SHA, `Verify` run URL, artifact filename and digest, publish result,
and known limitations. The release workflow verifies the exact tag and
package artifact. Never put credentials, raw audio, or full transcripts in a
release record.

## After publishing 2.1.0

Confirm npm reports `voice-runtime@2.1.0` with provenance before changing
downstream consumers. Platform must then replace its deleted worktree
dependency with `"voice-runtime": "2.1.0"`, refresh its lockfile, pass its
typecheck, and complete one browser call. The 2.1.0 package must export every
runtime symbol Platform's worker imports, including `createNodeMediaPlane`,
`createWebClientAudioProvider`, `createVoiceAgent`, `authorizeUpgrade`, and
`terminalReason`.
