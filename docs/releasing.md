# Releasing `voice-runtime`

The `release-npm` workflow handles the npm package release from the GitHub
Actions UI. You do not need to update the version locally, push a tag manually,
or create the GitHub Release in a separate panel.

## Before running it

1. Merge the package changes into `main`.
2. Confirm that the main-branch checks are green.
3. Confirm that npm trusted publishing is configured for:
   - repository: `Kkartik14/TVIC`;
   - workflow filename: `release.yml`;
   - allowed action: direct `npm publish`;
   - environment: blank, unless the workflow and npm configuration are changed
     together.

The workflow file keeps the name `release.yml` because npm matches the exact
filename. Its visible Actions name is `release-npm`.

## Run a verification first

1. Open the repository's **Actions** tab.
2. Select **release-npm**.
3. Select the `main` branch.
4. Click **Run workflow**.
5. Fill in the form. For the `1.0.1` release, use:

   | Field         | Value                                   |
   | ------------- | --------------------------------------- |
   | Version       | `1.0.1`                                 |
   | Release title | `voice-runtime v1.0.1`                  |
   | Release notes | A short Markdown summary of the release |
   | npm tag       | `latest`                                |
   | Pre-release   | unchecked                               |
   | Publish       | unchecked                               |

6. Start the workflow.

With **Publish** unchecked, the workflow runs linting, builds the workspace,
runs the test suite, exercises PostgreSQL and Redis integrations, verifies the
package exports, and tests the actual npm tarball. It does not change `main`,
create a tag, publish to npm, or create a GitHub Release.

## Publish after verification

Run the same workflow again with **Publish** checked. After all checks pass, it
will:

1. set `packages/voice-runtime/package.json` to the requested version;
2. commit the version change to `main`;
3. create and push `voice-runtime-v<version>`;
4. publish the package to npm with the selected distribution tag; and
5. create the GitHub Release with the title, notes, and pre-release setting from
   the form.

The workflow checks for an existing npm version and matching tag before it
publishes. This makes a retry safe when a previous run finished the npm publish
but stopped before creating the GitHub Release.

## Who can run it

The release job runs only when the original workflow actor and the actor
starting a re-run are both `Kkartik14`, and only when the selected branch is
`main`. GitHub may still show the workflow's **Run workflow** control to people
who have permission to use Actions, but the release job is skipped for anyone
else.

Keep the npm trusted-publisher configuration and this workflow filename in sync.
Changing `release.yml` to another filename requires updating npm's trusted
publisher configuration before publishing.
