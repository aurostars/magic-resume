import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL(
  "../src/app/app/dashboard/resumes/ResumeWorkbench.tsx",
  import.meta.url,
);

test("the import dialog subtree is absent when the dialog is closed", async () => {
  const source = await readFile(sourcePath, "utf8");
  const render = source.slice(source.indexOf("    return ("));

  assert.match(
    render,
    /\{isImportDialogOpen && \(\s*<ImportResumeDialog[\s\S]*?\/>\s*\)\}/,
    "ImportResumeDialog must be conditionally mounted, not kept mounted with open=false",
  );
});
