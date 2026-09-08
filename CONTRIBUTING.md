# Contributing to TVIC

TVIC is developed in the open, but every human contribution starts with a
GitHub issue. The issue gives the change a clear problem statement, scope, and
acceptance criteria before implementation begins.

## Required contribution path

1. Search existing issues and discussions.
2. Open the appropriate issue before changing code or documentation:
   - **Bug report** for incorrect or regressed behavior.
   - **Feature request** for new user-facing behavior or API.
   - **Documentation** for missing, misleading, or unclear guidance.
3. Wait for the scope to be acknowledged or agreed upon. A maintainer may
   refine the design, split the work, or close an issue that is out of scope.
4. Create a focused branch and implement only the agreed change.
5. Open a pull request that links the issue, explains the behavior change, and
   records the verification performed.

A direct pull request without a linked issue is not eligible for review or
approval. The only exception is a security fix, and even that exception must be
coordinated privately with a maintainer first. Do not disclose a vulnerability
in a public issue or pull request; follow the [security reporting
process](./SECURITY.md).

## Labels and titles

Use one primary issue category and add area labels when they apply. The issue
forms apply the primary labels automatically when those labels exist in the
repository:

| Category               | Title prefix              | Primary label   |
| ---------------------- | ------------------------- | --------------- |
| Bug                    | `[bug]`                   | `bug`           |
| Feature                | `[feature]`               | `enhancement`   |
| Documentation          | `[docs]`                  | `documentation` |
| Security vulnerability | Do not use a public issue | Private report  |

Useful area labels include `runtime`, `providers`, `media`, `transport`,
`persistence`, `tools`, `examples`, `ci`, and `release`. Lifecycle labels such
as `needs-triage`, `accepted`, `blocked`, and `help wanted` are maintained by
the project team. If a needed label is not available, describe the area in the
issue instead of creating a duplicate label.

## Pull requests

Every pull request should:

- link the issue with `Closes #123`, `Fixes #123`, or `Refs #123`;
- explain the user-visible behavior and any public API changes;
- include focused tests for changed behavior;
- update the relevant documentation and examples;
- call out compatibility, migration, security, and operational risks;
- keep unrelated refactors out of the change;
- contain no credentials, tokens, private URLs, recordings, or caller data.

Keep commits small enough to audit independently. If a change has several
independent concerns, split them into separate issues and pull requests.

## Local verification

Install the pinned workspace dependencies and run the repository gates:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
```

Changes to PostgreSQL, Redis, persistence adapters, transports, or provider
integrations should also be tested against the relevant real service when
possible. State exactly which checks were run in the pull request; do not claim
live-provider coverage when only mocks were used.

## Review expectations

Reviewers evaluate correctness at the public seam, not only whether the local
implementation looks reasonable. In particular, a change should preserve
typed contracts, explicit failure behavior, cancellation and interruption
semantics, authentication boundaries, and the documented provider capability
claims.

If a proposed change needs a design decision, discuss that decision in the
issue before turning the pull request into an implementation debate.
