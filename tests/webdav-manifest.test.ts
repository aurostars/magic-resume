import assert from "node:assert/strict";
import test from "node:test";
import { createManifest, parseManifest, serializeManifest } from "../src/lib/webdav/manifest";
import type { ManifestV2, ManifestV2Body } from "../src/lib/webdav/types";

const ID = "resume-a";
const HASH = "a".repeat(64);
const body = (): ManifestV2Body => ({
  schemaVersion: 2,
  revision: 1,
  parentRevision: null,
  updatedAt: "2026-09-13T03:00:00.000Z",
  deviceId: "device-1",
  activeResumeId: ID,
  entries: {
    [ID]: {
      objectPath: `objects/${ID}/${HASH}.json`,
      mirrorPath: "resumes/Product Manager--resume.json",
      contentHash: HASH,
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

test("accepts immutable objectPath and readable mirrorPath and verifies manifest hash", async () => {
  const manifest = await createManifest(body());
  assert.deepEqual(await parseManifest(serializeManifest(manifest)), manifest);
});

test("requires objectPath to exactly bind full ID and content hash", async () => {
  for (const objectPath of [
    `objects/other/${HASH}.json`,
    `objects/${ID}/${"b".repeat(64)}.json`,
    `resumes/${ID}.json`,
    `objects/${ID}/../${HASH}.json`,
  ]) {
    const invalid = body();
    invalid.entries[ID].objectPath = objectPath;
    await assert.rejects(async () => parseManifest(await rehash(invalid)), objectPath);
  }
});

test("requires live mirrors in resumes and tombstone mirrors in trash", async () => {
  const live = body();
  live.entries[ID].mirrorPath = "trash/Product Manager--resume.json";
  await assert.rejects(async () => parseManifest(await rehash(live)));

  const deleted = body();
  deleted.activeResumeId = null;
  deleted.entries[ID].deleted = true;
  deleted.entries[ID].mirrorPath = "trash/Product Manager--resume.json";
  assert.equal((await parseManifest(await rehash(deleted))).entries[ID].deleted, true);
});

test("rejects unsafe, duplicate, or short-ID-inconsistent mirror paths", async () => {
  for (const mirrorPath of [
    "/resumes/a.json",
    "resumes/../trash/a.json",
    "resumes/Product--wrong.json",
  ]) {
    const invalid = body();
    invalid.entries[ID].mirrorPath = mirrorPath;
    await assert.rejects(async () => parseManifest(await rehash(invalid)), mirrorPath);
  }

  const duplicate = body();
  duplicate.entries["resume-b"] = {
    ...duplicate.entries[ID],
    objectPath: `objects/resume-b/${HASH}.json`,
  };
  await assert.rejects(async () => parseManifest(await rehash(duplicate)));
});

test("rejects unknown entry properties, invalid active ID, and a mismatched hash", async () => {
  const unknown = body();
  (unknown.entries[ID] as unknown as Record<string, unknown>).path = "resumes/legacy.json";
  await assert.rejects(async () => parseManifest(await rehash(unknown)));

  const inactive = body();
  inactive.activeResumeId = "missing";
  await assert.rejects(async () => parseManifest(await rehash(inactive)));

  const manifest = await createManifest(body());
  await rejects({ ...manifest, manifestHash: "0".repeat(64) });
});

test("rejects schema, metadata, and shape boundary violations", async () => {
  const valid = await createManifest(body());
  await rejects({ ...valid, schemaVersion: 1 });
  await rejects({ ...valid, unknown: true });
  for (const change of [
    { revision: -1 },
    { revision: 1.5 },
    { parentRevision: Number.POSITIVE_INFINITY },
    { updatedAt: "2026-09-13T03:00:00Z" },
    { deviceId: "" },
  ]) {
    await assert.rejects(async () => parseManifest(await rehash({ ...body(), ...change })));
  }
});
