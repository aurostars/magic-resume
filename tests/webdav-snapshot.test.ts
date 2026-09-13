import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import type { ResumeData } from "../src/types/resume";
import { SnapshotValidationError, type ResumeSyncData } from "../src/lib/webdav/types";
import {
  calculateContentHash,
  canonicalizeSyncData,
  createCloudSnapshot,
  parseCloudSnapshot,
} from "../src/lib/webdav/snapshot";

const resume = (id: string): ResumeData => ({
  ...structuredClone(initialResumeState),
  id,
  title: `Resume ${id}`,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
  templateId: null,
});

test("canonical data sorts resume arrays and nested object keys", () => {
  const first = { resumes: [resume("b"), resume("a")], activeResumeId: "a" };
  const second = { resumes: [resume("a"), resume("b")], activeResumeId: "a" };
  assert.equal(canonicalizeSyncData(first), canonicalizeSyncData(second));
});

test("snapshot hash covers data only and validates after metadata changes", async () => {
  const data = { resumes: [resume("a")], activeResumeId: "a" };
  const hash = await calculateContentHash(data);
  const snapshot = await createCloudSnapshot(data, {
    revision: "revision-1",
    parentRevision: null,
    updatedAt: "2026-09-12T12:00:00.000Z",
    deviceId: "device-1",
  });
  assert.equal(snapshot.contentHash, hash);
  const parsed = await parseCloudSnapshot(
    JSON.stringify({ ...snapshot, updatedAt: "2026-09-12T13:00:00.000Z" }),
  );
  assert.equal(parsed.updatedAt, "2026-09-12T13:00:00.000Z");
});

test("parser rejects a higher schema and a mismatched content hash", async () => {
  const data = { resumes: [resume("a")], activeResumeId: "a" };
  const snapshot = await createCloudSnapshot(data, {
    revision: "revision-1",
    parentRevision: null,
    updatedAt: "2026-09-12T12:00:00.000Z",
    deviceId: "device-1",
  });
  await assertValidationCode(
    () => parseCloudSnapshot(JSON.stringify({ ...snapshot, schemaVersion: 2 })),
    "SNAPSHOT_VERSION",
  );
  await assertValidationCode(
    () =>
      parseCloudSnapshot(
        JSON.stringify({ ...snapshot, contentHash: "0".repeat(64) }),
      ),
    "SNAPSHOT_HASH",
  );
});

test("parser rejects a dangling activeResumeId instead of repairing it", async () => {
  const snapshot = await createCloudSnapshot(
    { resumes: [resume("a")], activeResumeId: "a" },
    {
      revision: "revision-1",
      parentRevision: null,
      updatedAt: "2026-09-12T12:00:00.000Z",
      deviceId: "device-1",
    },
  );
  snapshot.data.activeResumeId = "missing";
  snapshot.contentHash = await calculateContentHash(snapshot.data);

  await assertValidationCode(
    () => parseCloudSnapshot(JSON.stringify(snapshot)),
    "SNAPSHOT_RESUME",
  );
});


const assertValidationCode = async (
  action: () => Promise<unknown>,
  code: SnapshotValidationError["code"],
): Promise<void> => {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SnapshotValidationError);
    assert.equal(error.code, code);
    return true;
  });
};

const snapshotWithData = async (data: unknown): Promise<string> => {
  const contentHash = await calculateContentHash(data as ResumeSyncData);
  return JSON.stringify({
    schemaVersion: 1,
    revision: "revision-1",
    parentRevision: null,
    updatedAt: "2026-09-12T12:00:00.000Z",
    deviceId: "device-1",
    contentHash,
    data,
  });
};

test("parser rejects hash-valid resumes missing required structure", async () => {
  const withoutBasic = { ...resume("a") } as Partial<ResumeData>;
  delete withoutBasic.basic;
  await assertValidationCode(
    async () => parseCloudSnapshot(await snapshotWithData({ resumes: [withoutBasic], activeResumeId: "a" })),
    "SNAPSHOT_RESUME",
  );

  const withoutProjects = { ...resume("a") } as Partial<ResumeData>;
  delete withoutProjects.projects;
  await assertValidationCode(
    async () => parseCloudSnapshot(await snapshotWithData({ resumes: [withoutProjects], activeResumeId: "a" })),
    "SNAPSHOT_RESUME",
  );
});

test("parser reports validation codes for malformed snapshot boundaries", async () => {
  await assertValidationCode(() => parseCloudSnapshot("not-json"), "SNAPSHOT_JSON");

  const valid = await createCloudSnapshot(
    { resumes: [resume("a")], activeResumeId: "a" },
    {
      revision: "revision-1",
      parentRevision: null,
      updatedAt: "2026-09-12T12:00:00.000Z",
      deviceId: "device-1",
    },
  );
  const { deviceId: _deviceId, ...missingField } = valid;
  await assertValidationCode(
    () => parseCloudSnapshot(JSON.stringify(missingField)),
    "SNAPSHOT_SHAPE",
  );
  await assertValidationCode(
    () => parseCloudSnapshot(JSON.stringify({ ...valid, updatedAt: "not-a-date" })),
    "SNAPSHOT_SHAPE",
  );

  const duplicate = { resumes: [resume("a"), resume("a")], activeResumeId: "a" };
  await assertValidationCode(
    async () => parseCloudSnapshot(await snapshotWithData(duplicate)),
    "SNAPSHOT_RESUME",
  );
  const emptyId = { resumes: [resume("")], activeResumeId: "" };
  await assertValidationCode(
    async () => parseCloudSnapshot(await snapshotWithData(emptyId)),
    "SNAPSHOT_RESUME",
  );
});

test("parser rejects non-canonical raw data instead of normalizing before hash verification", async () => {
  const raw = { resumes: [resume("b"), resume("a")], activeResumeId: "a" };
  await assertValidationCode(
    async () => parseCloudSnapshot(await snapshotWithData(raw)),
    "SNAPSHOT_SHAPE",
  );
});

test("parser rejects unknown keys on fixed objects but permits protocol dynamic maps", async () => {
  const validResume = resume("a");
  validResume.basic.icons.customNetwork = "custom-icon";
  validResume.customData.dynamicSection = [{
    id: "custom-1",
    title: "Title",
    subtitle: "Subtitle",
    dateRange: "2026",
    description: "Description",
    visible: true,
  }];
  const valid = await createCloudSnapshot(
    { resumes: [validResume], activeResumeId: "a" },
    {
      revision: "revision-1",
      parentRevision: null,
      updatedAt: "2026-09-12T12:00:00.000Z",
      deviceId: "device-1",
    },
  );
  await parseCloudSnapshot(JSON.stringify(valid));

  const damagedCases: Array<[Record<string, any>, SnapshotValidationError["code"]]> = [
    [{ ...valid, unknown: true }, "SNAPSHOT_SHAPE"],
    [{ ...valid, data: { ...valid.data, unknown: true } }, "SNAPSHOT_SHAPE"],
    [{
      ...valid,
      data: {
        ...valid.data,
        resumes: [{ ...valid.data.resumes[0], unknown: true }],
      },
    }, "SNAPSHOT_RESUME"],
    [{
      ...valid,
      data: {
        ...valid.data,
        resumes: [{
          ...valid.data.resumes[0],
          basic: { ...valid.data.resumes[0].basic, unknown: true },
        }],
      },
    }, "SNAPSHOT_RESUME"],
  ];
  for (const [damaged, code] of damagedCases) {
    damaged.contentHash = await calculateContentHash(damaged.data);
    await assertValidationCode(
      () => parseCloudSnapshot(JSON.stringify(damaged)),
      code,
    );
  }
});

test("empty resume data requires a null activeResumeId", async () => {
  const text = await snapshotWithData({ resumes: [], activeResumeId: "missing" });
  await assertValidationCode(() => parseCloudSnapshot(text), "SNAPSHOT_RESUME");
});
