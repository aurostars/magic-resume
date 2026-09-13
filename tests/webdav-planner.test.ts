import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import { planSync } from "../src/lib/webdav/planner";
import type {
  ManifestV2,
  MultiFileBaseline,
  ResumeManifestEntry,
} from "../src/lib/webdav/types";
import type { ResumeData } from "../src/types/resume";

const hash = (character: string): string => character.repeat(64);

const resume = (id: string, title = `Resume ${id}`): ResumeData => ({
  ...structuredClone(initialResumeState),
  id,
  title,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  templateId: null,
});

const entry = (
  id: string,
  contentHash: string,
  deleted = false,
  mirrorPath = `${deleted ? "trash" : "resumes"}/Resume ${id}--${id.slice(0, 6).toLowerCase()}.json`,
): ResumeManifestEntry => ({
  objectPath: `objects/${id}/${contentHash}.json`,
  mirrorPath,
  contentHash,
  updatedAt: "2026-09-13T03:00:00.000Z",
  deleted,
});

const manifest = (
  entries: Record<string, ResumeManifestEntry> = {},
  activeResumeId: string | null = null,
): ManifestV2 => ({
  schemaVersion: 2,
  revision: 2,
  parentRevision: 1,
  updatedAt: "2026-09-13T03:00:00.000Z",
  deviceId: "remote-device",
  activeResumeId,
  entries,
  manifestHash: hash("f"),
});

const baseline = (
  entries: MultiFileBaseline["entries"],
  activeResumeId: string | null = null,
): MultiFileBaseline => ({
  manifestRevision: 1,
  manifestHash: hash("e"),
  activeResumeId,
  entries,
});

const baselineEntry = (
  id: string,
  contentHash: string,
  deleted = false,
  mirrorPath = `${deleted ? "trash" : "resumes"}/Resume ${id}--${id.slice(0, 6).toLowerCase()}.json`,
) => ({ contentHash, deleted, objectPath: `objects/${id}/${contentHash}.json`, mirrorPath });

const plan = ({
  resumes = [],
  activeResumeId = null,
  localHashes = {},
  remote = manifest(),
  previous = null,
}: {
  resumes?: ResumeData[];
  activeResumeId?: string | null;
  localHashes?: Record<string, string>;
  remote?: ManifestV2 | null;
  previous?: MultiFileBaseline | null;
} = {}) => planSync({
  local: { resumes, activeResumeId },
  localHashes,
  remote,
  baseline: previous,
});

test("no baseline with local resumes and empty remote uploads by full ID in deterministic order", () => {
  const resumeZ = resume("shared-prefix-z");
  const resumeA = resume("shared-prefix-a");

  const result = plan({
    resumes: [resumeZ, resumeA],
    localHashes: { "shared-prefix-z": hash("z"), "shared-prefix-a": hash("a") },
  });

  assert.deepEqual(result.uploads.map(({ resume: item }) => item.id), [
    "shared-prefix-a",
    "shared-prefix-z",
  ]);
  assert.deepEqual(result.downloads, []);
  assert.deepEqual(result.conflicts, []);
});

test("no baseline with remote resumes and empty local downloads in deterministic order", () => {
  const result = plan({
    remote: manifest({
      "shared-prefix-z": entry("shared-prefix-z", hash("z")),
      "shared-prefix-a": entry("shared-prefix-a", hash("a")),
    }),
  });

  assert.deepEqual(result.downloads.map(({ resumeId }) => resumeId), [
    "shared-prefix-a",
    "shared-prefix-z",
  ]);
  assert.deepEqual(result.uploads, []);
  assert.deepEqual(result.conflicts, []);
});

test("only local changed uploads the resume", () => {
  const local = resume("resume-a");
  const old = baselineEntry(local.id, hash("a"));
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("b") },
    remote: manifest({ [local.id]: entry(local.id, hash("a")) }),
    previous: baseline({ [local.id]: old }),
  });

  assert.deepEqual(result.uploads, [{
    resume: local,
    mirrorPath: "resumes/Resume resume-a--resume.json",
    previousMirrorPath: null,
  }]);
  assert.deepEqual(result.downloads, []);
});

test("only remote changed downloads the resume and ignores timestamps", () => {
  const local = resume("resume-a");
  const remoteEntry = {
    ...entry(local.id, hash("b")),
    updatedAt: "2000-01-01T00:00:00.000Z",
  };
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("a") },
    remote: manifest({ [local.id]: remoteEntry }),
    previous: baseline({ [local.id]: baselineEntry(local.id, hash("a")) }),
  });

  assert.deepEqual(result.downloads, [{
    resumeId: local.id,
    objectPath: remoteEntry.objectPath,
    contentHash: hash("b"),
  }]);
  assert.deepEqual(result.uploads, []);
});

test("both changed to the same hash produces no conflict or transfer", () => {
  const local = resume("resume-a");
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("b") },
    remote: manifest({ [local.id]: entry(local.id, hash("b")) }),
    previous: baseline({ [local.id]: baselineEntry(local.id, hash("a")) }),
  });

  assert.deepEqual(result.uploads, []);
  assert.deepEqual(result.downloads, []);
  assert.deepEqual(result.conflicts, []);
});

test("both changed to different hashes produces a both-modified conflict", () => {
  const local = resume("resume-a");
  const remoteEntry = entry(local.id, hash("c"));
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("b") },
    remote: manifest({ [local.id]: remoteEntry }),
    previous: baseline({ [local.id]: baselineEntry(local.id, hash("a")) }),
  });

  assert.deepEqual(result.conflicts, [{
    resumeId: local.id,
    title: local.title,
    kind: "both-modified",
    localUpdatedAt: local.updatedAt,
    remoteUpdatedAt: remoteEntry.updatedAt,
    local,
    remoteEntry,
  }]);
  assert.deepEqual(result.uploads, []);
  assert.deepEqual(result.downloads, []);
});

test("local deletion with unchanged remote moves the remote file to trash", () => {
  const id = "resume-a";
  const remoteEntry = entry(id, hash("a"));
  const result = plan({
    remote: manifest({ [id]: remoteEntry }),
    previous: baseline({ [id]: baselineEntry(id, hash("a")) }),
  });

  assert.deepEqual(result.trashMoves, [{
    resumeId: id,
    from: remoteEntry.mirrorPath,
    to: "trash/Resume resume-a--resume.json",
  }]);
});

test("remote deletion with unchanged local schedules local deletion", () => {
  const local = resume("resume-a");
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("a") },
    remote: manifest({ [local.id]: entry(local.id, hash("a"), true) }),
    previous: baseline({ [local.id]: baselineEntry(local.id, hash("a")) }),
  });

  assert.deepEqual(result.remoteDeletions, [local.id]);
});

test("local deletion with changed remote produces a delete-vs-modify conflict", () => {
  const id = "resume-a";
  const remoteEntry = entry(id, hash("b"));
  const result = plan({
    remote: manifest({ [id]: remoteEntry }),
    previous: baseline({ [id]: baselineEntry(id, hash("a")) }),
  });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].resumeId, id);
  assert.equal(result.conflicts[0].kind, "delete-vs-modify");
  assert.equal(result.conflicts[0].localUpdatedAt, null);
  assert.equal(result.conflicts[0].remoteUpdatedAt, remoteEntry.updatedAt);
  assert.equal(result.conflicts[0].local, null);
  assert.deepEqual(result.conflicts[0].remoteEntry, remoteEntry);
});

test("remote deletion with changed local produces a delete-vs-modify conflict", () => {
  const local = resume("resume-a");
  const remoteEntry = entry(local.id, hash("a"), true);
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("b") },
    remote: manifest({ [local.id]: remoteEntry }),
    previous: baseline({ [local.id]: baselineEntry(local.id, hash("a")) }),
  });

  assert.deepEqual(result.conflicts, [{
    resumeId: local.id,
    title: local.title,
    kind: "delete-vs-modify",
    localUpdatedAt: local.updatedAt,
    remoteUpdatedAt: remoteEntry.updatedAt,
    local,
    remoteEntry,
  }]);
});

test("changes to different full resume IDs upload one and download one without conflict", () => {
  const first = resume("same-prefix-111111");
  const second = resume("same-prefix-222222");
  const result = plan({
    resumes: [first, second],
    localHashes: { [first.id]: hash("x"), [second.id]: hash("b") },
    remote: manifest({
      [first.id]: entry(first.id, hash("a")),
      [second.id]: entry(second.id, hash("y")),
    }),
    previous: baseline({
      [first.id]: baselineEntry(first.id, hash("a")),
      [second.id]: baselineEntry(second.id, hash("b")),
    }),
  });

  assert.deepEqual(result.uploads.map(({ resume: item }) => item.id), [first.id]);
  assert.deepEqual(result.downloads.map(({ resumeId }) => resumeId), [second.id]);
  assert.deepEqual(result.conflicts, []);
});

test("title-only change uploads to the new path and retains previousPath", () => {
  const local = resume("resume-a", "New Title");
  const oldPath = "resumes/Old Title--resume.json";
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("b") },
    remote: manifest({ [local.id]: entry(local.id, hash("a"), false, oldPath) }),
    previous: baseline({
      [local.id]: baselineEntry(local.id, hash("a"), false, oldPath),
    }),
  });

  assert.deepEqual(result.uploads, [{
    resume: local,
    mirrorPath: "resumes/New Title--resume.json",
    previousMirrorPath: oldPath,
  }]);
});

test("invalid active ID falls back to the first live full ID or null", () => {
  const resumeZ = resume("same-prefix-z");
  const resumeA = resume("same-prefix-a");
  const withLiveResumes = plan({
    resumes: [resumeZ, resumeA],
    activeResumeId: "missing",
    localHashes: { [resumeZ.id]: hash("z"), [resumeA.id]: hash("a") },
    remote: manifest({}, "also-missing"),
  });
  const withoutLiveResumes = plan({
    activeResumeId: "missing",
    remote: manifest({}, "also-missing"),
  });

  assert.equal(withLiveResumes.nextActiveResumeId, resumeA.id);
  assert.equal(withoutLiveResumes.nextActiveResumeId, null);
});


test("remote hard deletion with changed local produces a delete-vs-modify conflict", () => {
  const local = resume("resume-hard-deleted");
  const result = plan({
    resumes: [local],
    localHashes: { [local.id]: hash("b") },
    remote: manifest(),
    previous: baseline({ [local.id]: baselineEntry(local.id, hash("a")) }),
  });

  assert.deepEqual(result.conflicts, [{
    resumeId: local.id,
    title: local.title,
    kind: "delete-vs-modify",
    localUpdatedAt: local.updatedAt,
    remoteUpdatedAt: "2026-09-13T03:00:00.000Z",
    local,
    remoteEntry: null,
  }]);
});

test("deleting the only resume makes the next active ID null", () => {
  const id = "only-resume";
  const result = plan({
    activeResumeId: id,
    remote: manifest({ [id]: entry(id, hash("a")) }, id),
    previous: baseline({ [id]: baselineEntry(id, hash("a")) }, id),
  });

  assert.deepEqual(result.trashMoves.map(({ resumeId }) => resumeId), [id]);
  assert.equal(result.nextActiveResumeId, null);
});

test("deleting the active resume selects the first remaining full ID", () => {
  const deletedId = "same-prefix-current";
  const resumeZ = resume("same-prefix-z");
  const resumeA = resume("same-prefix-a");
  const result = plan({
    resumes: [resumeZ, resumeA],
    activeResumeId: deletedId,
    localHashes: { [resumeZ.id]: hash("z"), [resumeA.id]: hash("a") },
    remote: manifest({
      [deletedId]: entry(deletedId, hash("d")),
      [resumeZ.id]: entry(resumeZ.id, hash("z")),
      [resumeA.id]: entry(resumeA.id, hash("a")),
    }, deletedId),
    previous: baseline({
      [deletedId]: baselineEntry(deletedId, hash("d")),
      [resumeZ.id]: baselineEntry(resumeZ.id, hash("z")),
      [resumeA.id]: baselineEntry(resumeA.id, hash("a")),
    }, deletedId),
  });

  assert.deepEqual(result.trashMoves.map(({ resumeId }) => resumeId), [deletedId]);
  assert.equal(result.nextActiveResumeId, resumeA.id);
});
