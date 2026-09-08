# TVIC skills for AI coding agents

TVIC can install a small guidance skill into the current project. The skill helps
Claude Code, Codex, and other compatible agents understand the `voice-runtime`
package, its provider-neutral design, its transport boundary, and its security
rules.

## Install the package first

```bash
npm install voice-runtime
```

The package installation itself does not change your project. To install the
optional TVIC skill, run this explicit command from the project directory:

```bash
npx voice-runtime skills install
```

The command shows the target project and asks for a `y` confirmation before
writing anything. Declining it leaves the project unchanged.

## Choose an agent

Without an option, the command prepares the skill for Claude Code, Codex, and
OpenRouter-compatible agents. The two shared targets are written only once:

| Agent                        | Project skill path             |
| ---------------------------- | ------------------------------ |
| Claude Code                  | `.claude/skills/tvic/SKILL.md` |
| Codex                        | `.agents/skills/tvic/SKILL.md` |
| OpenRouter-compatible agents | `.agents/skills/tvic/SKILL.md` |

OpenRouter does not define a separate local skill directory. Its official agent
guidance uses the shared Agent Skills format, so the same `.agents/skills` file
is the portable project target. This does not install OpenRouter's separate SDK
skill collection.

Install only selected targets when needed:

```bash
npx voice-runtime skills install --agent claude
npx voice-runtime skills install --agent codex
npx voice-runtime skills install --agent openrouter
```

Multiple agents can be selected with repeated flags or a comma-separated value:

```bash
npx voice-runtime skills install --agent codex --agent openrouter
npx voice-runtime skills install --agent claude,codex
```

## Automation and existing files

Use `--yes` when a script has already decided to install the skill:

```bash
npx voice-runtime skills install --yes
```

Use `--dry-run` to see the planned paths without writing files. An existing
TVIC skill file is never replaced automatically. Review it first, then use
`--force` only when replacement is intentional:

```bash
npx voice-runtime skills install --dry-run
npx voice-runtime skills install --force --yes
```

TVIC installs project-scoped guidance only. It does not write to a user's home
directory, download arbitrary code, install provider credentials, or add a
background install hook.

## What the skill teaches the agent

The installed `SKILL.md` covers:

- when to use the managed API versus the composable API;
- how transports provide an authenticated `CallHandle`;
- how STT, the language model, tools, and TTS connect;
- provider selection, model catalogs, and maturity labels;
- interruption, cancellation, and playout evidence;
- application-owned authorization and domain actions;
- how to test a real transport separately from mocked providers.

Skills are on-demand instructions. The agent first sees the skill name and
description, then loads the full file when the task matches it. Read the file
before trusting it, just as you would review a build script or project config.
