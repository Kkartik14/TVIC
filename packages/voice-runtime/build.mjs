import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { build } from "esbuild";
import { rollup } from "rollup";
import dts from "rollup-plugin-dts";

const execFileAsync = promisify(execFile);

await rm("dist", { recursive: true, force: true });
await rm("dist-types", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await execFileAsync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
  stdio: "inherit",
});

const shared = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["ws"],
  sourcemap: true,
  legalComments: "eof",
};

await build({ ...shared, format: "esm", outfile: "dist/index.js" });
await build({ ...shared, format: "cjs", outfile: "dist/index.cjs" });

const commonJs = await readFile("dist/index.cjs", "utf8");
if (commonJs.includes("import.meta")) {
  throw new Error("voice-runtime CJS bundle must not contain import.meta");
}

const declarationBundle = await rollup({
  input: "src/index.ts",
  external: [/^node:/, "ws"],
  plugins: [
    dts({
      includeExternal: [
        "@tvic/core",
        "@tvic/dal",
        "@tvic/dal-codec",
        "@tvic/dal-composite",
        "@tvic/dal-postgres",
        "@tvic/dal-postgres-memory",
        "@tvic/dal-redis",
        "@tvic/media",
        "@tvic/providers",
        "@tvic/runtime",
        "@tvic/tools",
      ],
    }),
  ],
});
await declarationBundle.write({ file: "dist/index.d.ts", format: "es" });
await declarationBundle.close();
