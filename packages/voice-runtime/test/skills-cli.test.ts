import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/voice-runtime.mjs", import.meta.url));
const sourceSkillPath = fileURLToPath(new URL("../skills/tvic/SKILL.md", import.meta.url));
const temporaryDirectories: string[] = [];

async function runCli(args: string[], cwd: string) {
  return execFileAsync(process.execPath, [cliPath, ...args], { cwd });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("voice-runtime skills CLI", () => {
  it("installs Claude, Codex, and OpenRouter targets with one shared agents file", async () => {
    const projectDirectory = await mkdtemp(`${tmpdir()}/voice-runtime-skills-`);
    temporaryDirectories.push(projectDirectory);

    await runCli(
      ["skills", "install", "--yes", "--agent", "claude,codex,openrouter"],
      projectDirectory,
    );

    const source = await readFile(sourceSkillPath, "utf8");
    await expect(
      readFile(`${projectDirectory}/.claude/skills/tvic/SKILL.md`, "utf8"),
    ).resolves.toBe(source);
    await expect(
      readFile(`${projectDirectory}/.agents/skills/tvic/SKILL.md`, "utf8"),
    ).resolves.toBe(source);
  });

  it("does not write during a dry run and protects existing files", async () => {
    const projectDirectory = await mkdtemp(`${tmpdir()}/voice-runtime-skills-`);
    temporaryDirectories.push(projectDirectory);
    const skillPath = `${projectDirectory}/.agents/skills/tvic/SKILL.md`;

    await runCli(["skills", "install", "--dry-run", "--agent", "codex"], projectDirectory);
    await expect(exists(skillPath)).resolves.toBe(false);

    await runCli(["skills", "install", "--yes", "--agent", "codex"], projectDirectory);
    await writeFile(skillPath, "project-owned skill\n", "utf8");

    await expect(
      runCli(["skills", "install", "--yes", "--agent", "codex"], projectDirectory),
    ).rejects.toMatchObject({ code: 1 });
    await expect(readFile(skillPath, "utf8")).resolves.toBe("project-owned skill\n");

    await runCli(["skills", "install", "--yes", "--force", "--agent", "codex"], projectDirectory);
    await expect(readFile(skillPath, "utf8")).resolves.toBe(
      await readFile(sourceSkillPath, "utf8"),
    );
  });
});
