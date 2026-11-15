import { build } from "esbuild";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "vercel-search-test-"));
try {
  const tests = [];
  for (const file of await readdir(root)) {
    if (!file.endsWith(".test.ts")) continue;
    const output = join(temporary, file.replace(/\.ts$/, ".mjs"));
    await build({
      entryPoints: [join(root, file)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: output,
    });
    tests.push(output);
  }
  if (!tests.length) throw new Error("No plugin tests found");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ["--test", ...tests], {
    stdio: "inherit",
    env,
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
