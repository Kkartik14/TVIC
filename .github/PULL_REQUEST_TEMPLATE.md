## Related issue

Every human pull request must be connected to an issue. Use `Closes #123`,
`Fixes #123`, or `Refs #123`.

- Issue: #

If this is a security fix, do not disclose vulnerability details here unless a
maintainer has explicitly confirmed that public disclosure is safe. Security
fixes must be reported privately first; see [SECURITY.md](../SECURITY.md).

## Change type

- [ ] Bug fix (`bug`)
- [ ] Feature or public API (`enhancement`)
- [ ] Documentation (`documentation`)
- [ ] Security fix (maintainer-coordinated exception)
- [ ] Other maintenance (describe in the summary)

## Summary

<!-- What changed for users? Keep implementation details secondary. -->

## Verification

<!-- List the exact commands and relevant real-service/provider coverage. -->

```text

```

## Risk and compatibility

- Public API or behavior changes:
- Migration or release-note impact:
- Security or data-handling impact:
- Provider, transport, database, or Redis impact:

## Checklist

- [ ] The change is scoped to the linked issue.
- [ ] Tests cover the changed behavior.
- [ ] Documentation and examples are updated where needed.
- [ ] No credentials, tokens, private URLs, recordings, or caller data are included.
- [ ] The CI checks pass, or failures are explained above.
