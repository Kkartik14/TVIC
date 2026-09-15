# Releasing `voice-runtime`

The `npm release` workflow publishes `voice-runtime` after a GitHub Release is
published. The Releases tab is the release control surface. Actions does not
change `main`, create a branch, create a tag, or create a GitHub Release.

## Before a release

1. Change `packages/voice-runtime/package.json` to the new version in a normal
   pull request.
2. Wait for the required `verify` check and merge the pull request into `main`.
3. Confirm that the package version has not already been published to npm.
4. Confirm that npm trusted publishing still points to repository
   `Kkartik14/TVIC`, workflow file `release.yml`, and the intended environment
   configuration.

The package version and release tag must match. For version `1.0.1`, both must
use `1.0.1`:

```text
packages/voice-runtime/package.json  ->  "version": "1.0.1"
GitHub tag                            ->  voice-runtime-v1.0.1
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
`npm release` workflow.

## What the workflow verifies

The workflow checks out the exact release tag and then:

- installs the locked workspace dependencies;
- runs lint and the complete release verification suite;
- exercises PostgreSQL and Redis integrations;
- builds the workspace and the publish artifact;
- verifies package exports and the external npm package path;
- checks that the release tag version matches `package.json`;
- rejects an npm version that already exists;
- publishes with npm trusted publishing and provenance.

The workflow does not run `git commit`, `git push`, `git tag`, or
`gh release create`.

## If the workflow fails

Do not create a second tag or release with the same version. Open the failed
workflow run, fix the reported issue in a pull request, and rerun the failed
job when the fix is available.

If npm reports that the version already exists, do not attempt to publish it
again. Verify the package page and provenance, then treat the npm version as
immutable and investigate only the missing release evidence.

## Trusted publishing configuration

The workflow filename must remain `release.yml` unless the npm trusted-publisher
configuration is updated at the same time. The publishing job needs an OIDC
token and does not use a long-lived npm token in repository secrets.

Keep release permissions limited to maintainers. Repository and branch settings
control who can merge the version bump and publish a GitHub Release.
