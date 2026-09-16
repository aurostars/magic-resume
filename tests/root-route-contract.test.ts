import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL("../src/routes/index.tsx", import.meta.url);

test("root route redirects directly to the resume dashboard", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /redirect\(\{\s*to: "\/app\/dashboard\/resumes"\s*\}\)/);
  assert.doesNotMatch(source, /getPreferredLocale/);
  assert.doesNotMatch(source, /to: "\/\$locale"/);
});
