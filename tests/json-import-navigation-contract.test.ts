import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL(
  "../src/app/app/dashboard/resumes/ResumeWorkbench.tsx",
  import.meta.url,
);

test("JSON import defers workbench navigation until the import dialog closes", async () => {
  const source = await readFile(sourcePath, "utf8");
  const importHandler = source.match(
    /const importResumeFromJson = async \(file: File\) => \{([\s\S]*?)\n    \};/,
  );

  assert.ok(importHandler, "importResumeFromJson function body should be present");
  assert.doesNotMatch(importHandler[1], /router\.push\s*\(/);
  assert.match(
    importHandler[1],
    /setPendingImportedResumeId\(resumeId\);\s*setIsImportDialogOpen\(false\);/,
  );
  assert.match(
    source,
    /const \[pendingImportedResumeId, setPendingImportedResumeId\] = useState<string \| null>\(null\);/,
  );
  assert.match(
    source,
    /useDeferredDialogNavigation\(\{\s*isDialogOpen: isImportDialogOpen,\s*pendingId: pendingImportedResumeId,\s*clearPendingId: \(\) => setPendingImportedResumeId\(null\),\s*navigate: \(id\) => router\.push\(\{ to: "\/app\/workbench\/\$id", params: \{ id \} \}\),\s*\}\);/,
  );
});
