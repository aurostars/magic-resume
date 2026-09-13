import assert from "node:assert/strict";
import test from "node:test";
import { createManifest, parseManifest, serializeManifest } from "../src/lib/webdav/manifest";
import type { ManifestV2, ManifestV2Body } from "../src/lib/webdav/types";

const body = (): ManifestV2Body => ({
  schemaVersion: 2,
  revision: 1,
  parentRevision: 0,
  updatedAt: "2026-09-13T03:00:00.000Z",
  deviceId: "device-1",
  activeResumeId: "resume-a",
  entries: {
    "resume-a": {
      path: "resumes/resume-a.json",
      contentHash: "a".repeat(64),
      updatedAt: "2026-09-13T03:00:00.000Z",
      deleted: false,
    },
  },
});

const rehash = async (value: ManifestV2Body): Promise<string> =>
  serializeManifest(await createManifest(value));

const rejects = async (value: unknown): Promise<void> => {
  await assert.rejects(() => parseManifest(JSON.stringify(value)));
};

test("accepts a valid v2 manifest and verifies its hash", async () => {
  const manifest = await createManifest(body());
  const parsed = await parseManifest(serializeManifest(manifest));
  assert.deepEqual(parsed, manifest);
  assert.match(parsed.manifestHash, /^[0-9a-f]{64}$/);
});

test("rejects schema versions other than 2", async () => {
  await rejects({ ...(await createManifest(body())), schemaVersion: 1 });
});

test("rejects an absolute entry path", async () => {
  const invalid = body();
  invalid.entries["resume-a"].path = "/resumes/a.json";
  await assert.rejects(async () => parseManifest(await rehash(invalid)));
});

test("rejects path traversal", async () => {
  const invalid = body();
  invalid.entries["resume-a"].path = "resumes/../trash/a.json";
  await assert.rejects(async () => parseManifest(await rehash(invalid)));
});

test("rejects duplicate entry paths for different IDs", async () => {
  const invalid = body();
  invalid.entries["resume-b"] = { ...invalid.entries["resume-a"] };
  await assert.rejects(async () => parseManifest(await rehash(invalid)));
});

test("requires live entries under resumes and deleted entries under trash", async () => {
  const liveInTrash = body();
  liveInTrash.entries["resume-a"].path = "trash/resume-a.json";
  await assert.rejects(async () => parseManifest(await rehash(liveInTrash)));

  const deletedInResumes = body();
  deletedInResumes.entries["resume-a"].deleted = true;
  await assert.rejects(async () => parseManifest(await rehash(deletedInResumes)));
});

test("rejects a missing or mismatched manifestHash", async () => {
  const manifest = await createManifest(body());
  const { manifestHash: _manifestHash, ...missing } = manifest;
  await rejects(missing);
  await rejects({ ...manifest, manifestHash: "0".repeat(64) });
});

test("rejects activeResumeId when it references a deleted or absent entry", async () => {
  const absent = body();
  absent.activeResumeId = "missing";
  await assert.rejects(async () => parseManifest(await rehash(absent)));

  const deleted = body();
  deleted.entries["resume-a"].path = "trash/resume-a.json";
  deleted.entries["resume-a"].deleted = true;
  await assert.rejects(async () => parseManifest(await rehash(deleted)));
});

test("rejects unknown properties, invalid metadata, and incomplete entry IDs", async () => {
  const valid = await createManifest(body());
  await rejects({ ...valid, unknown: true });

  const unknownEntry = body();
  (unknownEntry.entries["resume-a"] as unknown as Record<string, unknown>).unknown = true;
  await assert.rejects(async () => parseManifest(await rehash(unknownEntry)));

  for (const change of [
    { revision: -1 },
    { revision: 1.5 },
    { parentRevision: Number.POSITIVE_INFINITY },
    { updatedAt: "2026-09-13T03:00:00Z" },
    { deviceId: "" },
  ]) {
    await assert.rejects(async () => parseManifest(await rehash({ ...body(), ...change })));
  }

  const incompleteId = body();
  incompleteId.entries = { resume: incompleteId.entries["resume-a"] };
  await assert.rejects(async () => parseManifest(await rehash(incompleteId)));
});
