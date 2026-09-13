import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import type { RemotePrecondition, WebDavClientApi } from "../src/lib/webdav/client";
import {
  LocalCasMismatchError,
  WebDavSyncCoordinator,
  decideSync,
} from "../src/lib/webdav/coordinator";
import { WebDavError } from "../src/lib/webdav/errors";
import {
  calculateContentHash,
  canonicalizeSyncData,
  createCloudSnapshot,
} from "../src/lib/webdav/snapshot";
import type { CloudSnapshotV1, ResumeSyncData } from "../src/lib/webdav/types";
import type { WebDavBaseline } from "../src/store/useWebDavStore";
import type { ResumeData } from "../src/types/resume";

const NOW = "2026-09-12T15:30:00.000Z";
const FINAL_PATH = "/sync/magic-resume.json";
const TEMP_PATH = "/sync/magic-resume.revision-new.tmp";

const resume = (id: string, title = `Resume ${id}`): ResumeData => ({
  ...structuredClone(initialResumeState),
  id,
  title,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
  templateId: null,
});

const data = (title: string): ResumeSyncData => ({
  resumes: [resume("a", title)],
  activeResumeId: "a",
});

const baseline = (snapshot: CloudSnapshotV1): WebDavBaseline => ({
  revision: snapshot.revision,
  contentHash: snapshot.contentHash,
  syncedAt: NOW,
});

const snapshot = (
  syncData: ResumeSyncData,
  revision: string,
  parentRevision: string | null = null,
): Promise<CloudSnapshotV1> =>
  createCloudSnapshot(syncData, {
    revision,
    parentRevision,
    updatedAt: NOW,
    deviceId: "cloud-device",
  });

type ClientCall =
  | { method: "ensureDirectory"; path: string }
  | { method: "getText"; path: string }
  | { method: "putText"; path: string; content: string; precondition?: RemotePrecondition }
  | { method: "move"; source: string; destination: string; precondition?: RemotePrecondition }
  | { method: "delete"; path: string; signal: AbortSignal | undefined };

class RecordingClient implements WebDavClientApi {
  readonly calls: ClientCall[] = [];
  remoteText: string | null = null;
  remoteEtag: string | null = '"etag-1"';
  moveError: unknown = null;
  deleteError: unknown = null;
  onGetText: (() => void | Promise<void>) | null = null;
  onMove: (() => void | Promise<void>) | null = null;

  async options(): Promise<void> {}
  async propfind(): Promise<boolean> { return true; }
  async ensureDirectory(path: string): Promise<void> {
    this.calls.push({ method: "ensureDirectory", path });
  }
  async getText(path: string): Promise<string | null> {
    return (await this.getTextWithMetadata(path))?.text ?? null;
  }
  async getTextWithMetadata(path: string): Promise<{ text: string; etag: string | null } | null> {
    this.calls.push({ method: "getText", path });
    await this.onGetText?.();
    return this.remoteText === null ? null : { text: this.remoteText, etag: this.remoteEtag };
  }
  async putText(
    path: string,
    content: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
  ): Promise<void> {
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    this.calls.push({ method: "putText", path, content, precondition });
  }
  async move(
    source: string,
    destination: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
  ): Promise<void> {
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    this.calls.push({ method: "move", source, destination, precondition });
    await this.onMove?.();
    if (this.moveError) throw this.moveError;
  }
  async delete(path: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ method: "delete", path, signal });
    if (this.deleteError) throw this.deleteError;
  }
}

const setup = (options: {
  local?: ResumeSyncData;
  baseline?: WebDavBaseline | null;
  remoteText?: string | null;
} = {}) => {
  const client = new RecordingClient();
  client.remoteText = options.remoteText ?? null;
  let local = structuredClone(options.local ?? data("Local"));
  let currentBaseline = options.baseline ?? null;
  let commitCount = 0;
  let commitError: unknown = null;
  let getLocalDataCount = 0;
  let onGetLocalData: ((count: number) => void) | null = null;
  const coordinator = new WebDavSyncCoordinator({
    client,
    getLocalData: () => {
      const current = structuredClone(local);
      getLocalDataCount += 1;
      onGetLocalData?.(getLocalDataCount);
      return current;
    },
    commitDownloadedSnapshot: (next, nextBaseline, expectedLocalToken) => {
      commitCount += 1;
      if (canonicalizeSyncData(local) !== expectedLocalToken) {
        throw new LocalCasMismatchError();
      }
      if (commitError) throw commitError;
      local = structuredClone(next);
      currentBaseline = nextBaseline;
    },
    getBaseline: () => currentBaseline,
    setBaseline: (next) => { currentBaseline = next; },
    deviceId: "local-device",
    remoteDirectory: "/sync/",
    now: () => NOW,
    createRevision: () => "revision-new",
  });
  return {
    client,
    coordinator,
    local: () => local,
    baseline: () => currentBaseline,
    commitCount: () => commitCount,
    editLocal: (next: ResumeSyncData) => { local = structuredClone(next); },
    failCommitWith: (error: unknown) => { commitError = error; },
    onLocalRead: (callback: (count: number) => void) => { onGetLocalData = callback; },
  };
};

test("decideSync implements the complete three-way truth table", () => {
  const base: WebDavBaseline = { revision: "r1", contentHash: "base", syncedAt: NOW };
  const cases: Array<{
    name: string;
    localHash: string;
    cloud: { revision: string; contentHash: string } | null;
    baseline: WebDavBaseline | null;
    expected: "upload" | "download" | "none" | "conflict";
  }> = [
    { name: "cloud missing", localHash: "local", cloud: null, baseline: null, expected: "upload" },
    { name: "only local changed", localHash: "local-2", cloud: { revision: "r1", contentHash: "base" }, baseline: base, expected: "upload" },
    { name: "only cloud changed", localHash: "base", cloud: { revision: "r2", contentHash: "cloud-2" }, baseline: base, expected: "download" },
    { name: "both unchanged", localHash: "base", cloud: { revision: "r1", contentHash: "base" }, baseline: base, expected: "none" },
    { name: "both changed identically", localHash: "same", cloud: { revision: "r2", contentHash: "same" }, baseline: base, expected: "none" },
    { name: "both changed differently", localHash: "local-2", cloud: { revision: "r2", contentHash: "cloud-2" }, baseline: base, expected: "conflict" },
    { name: "first connection same content", localHash: "same", cloud: { revision: "r7", contentHash: "same" }, baseline: null, expected: "none" },
    { name: "first connection different content", localHash: "local", cloud: { revision: "r7", contentHash: "cloud" }, baseline: null, expected: "conflict" },
  ];

  for (const item of cases) {
    assert.equal(decideSync(item.localHash, item.cloud, item.baseline), item.expected, item.name);
  }
});

test("inspect parses the final remote snapshot and reports its decision", async () => {
  const local = data("Base");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const state = setup({ local, baseline: { revision: "r1", contentHash: cloud.parentRevision!, syncedAt: NOW }, remoteText: JSON.stringify(cloud) });

  const inspection = await state.coordinator.inspect();

  assert.equal(inspection.decision, "conflict");
  assert.equal(inspection.cloud?.revision, "r2");
  assert.deepEqual(inspection.localData, local);
  assert.equal(inspection.localHash, await calculateContentHash(local));
  assert.deepEqual(state.client.calls, [{ method: "getText", path: FINAL_PATH }]);
});

test("a local edit while remote GET waits prevents download from overwriting it", async () => {
  const baseData = data("Base");
  const editedData = data("Edited while waiting");
  const baseSnapshot = await snapshot(baseData, "r1");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const state = setup({
    local: baseData,
    baseline: baseline(baseSnapshot),
    remoteText: JSON.stringify(cloud),
  });
  state.client.onGetText = () => {
    state.client.onGetText = null;
    state.editLocal(editedData);
  };

  const result = await state.coordinator.execute();

  assert.equal(result.decision, "conflict");
  assert.deepEqual(state.local(), editedData);
  assert.equal(state.commitCount(), 0);
  assert.deepEqual(state.baseline(), baseline(baseSnapshot));
  assert.deepEqual(state.client.calls.map((call) => call.method), ["getText", "getText"]);
});

test("a local edit while remote GET waits is re-inspected and uploads the latest snapshot when remote is missing", async () => {
  const editedData = data("Edited while waiting");
  const state = setup({ local: data("Before GET"), remoteText: null });
  state.client.onGetText = () => {
    state.client.onGetText = null;
    state.editLocal(editedData);
  };

  const result = await state.coordinator.execute();

  assert.deepEqual(result, { status: "uploaded", warning: null });
  const put = state.client.calls.find(
    (call): call is Extract<ClientCall, { method: "putText" }> => call.method === "putText",
  );
  assert.ok(put);
  assert.deepEqual((JSON.parse(put.content) as CloudSnapshotV1).data, editedData);
  assert.deepEqual(state.local(), editedData);
  assert.deepEqual(state.client.calls.filter((call) => call.method === "getText").length, 2);
});

test("CAS rejects a download when local data changes after the second read but before commit", async () => {
  const baseData = data("Base");
  const editedData = data("Edited during hash");
  const baseSnapshot = await snapshot(baseData, "r1");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const state = setup({
    local: baseData,
    baseline: baseline(baseSnapshot),
    remoteText: JSON.stringify(cloud),
  });
  state.onLocalRead((count) => {
    if (count === 2) queueMicrotask(() => state.editLocal(editedData));
  });

  const result = await state.coordinator.execute();

  assert.equal(result.decision, "conflict");
  assert.equal(result.reason, undefined);
  assert.deepEqual(state.local(), editedData);
  assert.deepEqual(state.baseline(), baseline(baseSnapshot));
  assert.equal(state.commitCount(), 0);
});

test("an edit during the hash window is re-inspected and included in a safe upload", async () => {
  const inspectedData = data("Inspected");
  const editedData = data("Edited during hash");
  const state = setup({ local: inspectedData, remoteText: null });
  state.onLocalRead((count) => {
    if (count === 2) queueMicrotask(() => state.editLocal(editedData));
  });

  assert.deepEqual(await state.coordinator.execute(), { status: "uploaded", warning: null });

  const put = state.client.calls.find(
    (call): call is Extract<ClientCall, { method: "putText" }> => call.method === "putText",
  );
  assert.ok(put);
  assert.deepEqual((JSON.parse(put.content) as CloudSnapshotV1).data, editedData);
  assert.deepEqual(state.local(), editedData);
});

test("invalid remote JSON leaves local Store and baseline untouched", async () => {
  const local = data("Original");
  const oldBaseline = { revision: "r1", contentHash: "old", syncedAt: NOW };
  const state = setup({ local, baseline: oldBaseline, remoteText: "not-json" });

  await assert.rejects(() => state.coordinator.execute());

  assert.deepEqual(state.local(), local);
  assert.equal(state.commitCount(), 0);
  assert.equal(state.baseline(), oldBaseline);
});

test("upload performs ensureDirectory, temporary PUT, MOVE, cleanup in order and then updates baseline", async () => {
  const state = setup({ remoteText: null });

  const result = await state.coordinator.execute();

  assert.deepEqual(result, { status: "uploaded", warning: null });
  assert.deepEqual(state.client.calls.map((call) => call.method), ["getText", "ensureDirectory", "putText", "move", "delete"]);
  assert.deepEqual(state.client.calls.slice(1).map((call) => "path" in call ? call.path : [call.source, call.destination]), [
    "/sync/", TEMP_PATH, [TEMP_PATH, FINAL_PATH], TEMP_PATH,
  ]);
  const put = state.client.calls[2];
  assert.equal(put.method, "putText");
  const uploaded = JSON.parse(put.content) as CloudSnapshotV1;
  assert.equal(uploaded.revision, "revision-new");
  assert.equal(uploaded.parentRevision, null);
  assert.equal(state.baseline()?.revision, "revision-new");
  assert.equal(state.baseline()?.contentHash, uploaded.contentHash);
});

test("only MOVE_UNSUPPORTED falls back to direct final PUT and reports NON_ATOMIC_UPLOAD", async () => {
  const state = setup({ remoteText: null });
  state.client.moveError = new WebDavError("MOVE_UNSUPPORTED", 405);

  const result = await state.coordinator.execute();

  assert.deepEqual(result, { status: "uploaded", warning: "NON_ATOMIC_UPLOAD" });
  assert.deepEqual(state.client.calls.map((call) => call.method), ["getText", "ensureDirectory", "putText", "move", "putText", "delete"]);
  const directPut = state.client.calls[4];
  assert.equal(directPut.method, "putText");
  assert.equal(directPut.path, FINAL_PATH);
  assert.equal(state.baseline()?.revision, "revision-new");
});

test("a non-capability MOVE failure never overwrites the final file or baseline and still cleans temp", async () => {
  const oldBaseline = { revision: "r1", contentHash: "old", syncedAt: NOW };
  const state = setup({ baseline: oldBaseline, remoteText: null });
  state.client.moveError = new WebDavError("SERVER", 503);

  await assert.rejects(() => state.coordinator.execute(), (error: unknown) => error instanceof WebDavError && error.code === "SERVER");

  assert.deepEqual(state.client.calls.map((call) => call.method), ["getText", "ensureDirectory", "putText", "move", "delete"]);
  assert.equal(state.client.calls.some((call) => call.method === "putText" && call.path === FINAL_PATH), false);
  assert.equal(state.baseline(), oldBaseline);
});

test("temporary cleanup failure does not mask a successful upload", async () => {
  const state = setup({ remoteText: null });
  state.client.deleteError = new Error("cleanup failed");

  assert.deepEqual(await state.coordinator.execute(), { status: "uploaded", warning: null });
  assert.equal(state.baseline()?.revision, "revision-new");
});

test("execute returns a conflict without transfer or state changes", async () => {
  const local = data("Local");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const state = setup({ local, baseline: { revision: "r1", contentHash: "different-base", syncedAt: NOW }, remoteText: JSON.stringify(cloud) });

  const result = await state.coordinator.execute();

  assert.equal(result.decision, "conflict");
  assert.equal(result.cloud.revision, "r2");
  assert.deepEqual(state.client.calls.map((call) => call.method), ["getText"]);
  assert.equal(state.commitCount(), 0);
  assert.equal(state.baseline()?.revision, "r1");
});

test("keepLocal uploads against the current cloud revision as parentRevision", async () => {
  const cloud = await snapshot(data("Cloud"), "cloud-current");
  const state = setup({ remoteText: JSON.stringify(cloud) });

  const result = await state.coordinator.keepLocal(cloud, '"etag-1"');

  assert.deepEqual(result, { status: "uploaded", warning: null });
  const put = state.client.calls.find((call): call is Extract<ClientCall, { method: "putText" }> => call.method === "putText");
  assert.ok(put);
  assert.equal((JSON.parse(put.content) as CloudSnapshotV1).parentRevision, "cloud-current");
});

test("useCloud validates fully before applying once and updating baseline", async () => {
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const state = setup({ local: data("Local"), remoteText: JSON.stringify(cloud) });

  const result = await state.coordinator.useCloud(cloud, '"etag-1"');

  assert.deepEqual(result, { status: "downloaded", warning: null });
  assert.deepEqual(state.local(), cloud.data);
  assert.equal(state.commitCount(), 1);
  assert.deepEqual(state.baseline(), baseline(cloud));
});

test("useCloud honors an aborted conflict-resolution signal before commit", async () => {
  const local = data("Original");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const state = setup({ local });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => state.coordinator.useCloud(cloud, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );

  assert.deepEqual(state.local(), local);
  assert.equal(state.commitCount(), 0);
});

test("useCloud returns a structured conflict when CAS changes during validation", async () => {
  const local = data("Original");
  const editedData = data("Edited during validation");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const oldBaseline = { revision: "r1", contentHash: "old", syncedAt: NOW };
  const state = setup({ local, baseline: oldBaseline, remoteText: JSON.stringify(cloud) });
  state.onLocalRead((count) => {
    if (count === 2) queueMicrotask(() => state.editLocal(editedData));
  });

  const result = await state.coordinator.useCloud(cloud, '"etag-1"');

  assert.equal(result.decision, "conflict");
  assert.equal(result.reason, "LOCAL_CAS_MISMATCH");
  assert.deepEqual(state.local(), editedData);
  assert.equal(state.baseline(), oldBaseline);
  assert.equal(state.commitCount(), 1);
});

test("a failed atomic downloaded-snapshot commit leaves local data and baseline unchanged", async () => {
  const local = data("Original");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const oldBaseline = { revision: "r1", contentHash: "old", syncedAt: NOW };
  const state = setup({ local, baseline: oldBaseline, remoteText: JSON.stringify(cloud) });
  state.failCommitWith(new Error("persist failed"));

  await assert.rejects(() => state.coordinator.useCloud(cloud, '"etag-1"'), /persist failed/);

  assert.equal(state.commitCount(), 1);
  assert.deepEqual(state.local(), local);
  assert.equal(state.baseline(), oldBaseline);
});

test("useCloud rejects a damaged object without changing Store or baseline", async () => {
  const local = data("Original");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const damaged = { ...cloud, contentHash: "0".repeat(64) } as CloudSnapshotV1;
  const oldBaseline = { revision: "r1", contentHash: "old", syncedAt: NOW };
  const state = setup({ local, baseline: oldBaseline, remoteText: JSON.stringify(damaged) });

  await assert.rejects(() => state.coordinator.useCloud(damaged, '"etag-1"'));

  assert.deepEqual(state.local(), local);
  assert.equal(state.commitCount(), 0);
  assert.equal(state.baseline(), oldBaseline);
});

test("download validates then replaces Store exactly once and updates baseline", async () => {
  const baseData = data("Base");
  const baseSnapshot = await snapshot(baseData, "r1");
  const cloud = await snapshot(data("Cloud"), "r2", "r1");
  const state = setup({ local: baseData, baseline: baseline(baseSnapshot), remoteText: JSON.stringify(cloud) });

  assert.deepEqual(await state.coordinator.execute(), { status: "downloaded", warning: null });
  assert.deepEqual(state.local(), cloud.data);
  assert.equal(state.commitCount(), 1);
  assert.deepEqual(state.baseline(), baseline(cloud));
});

test("first connection with identical content establishes baseline without replacing local Store", async () => {
  const local = data("Same");
  const cloud = await snapshot(local, "r7");
  const state = setup({ local, remoteText: JSON.stringify(cloud) });

  assert.deepEqual(await state.coordinator.execute(), { status: "unchanged", warning: null });
  assert.equal(state.commitCount(), 0);
  assert.deepEqual(state.baseline(), baseline(cloud));
});


test("upload uses the inspected ETag and turns a concurrent remote replacement into a refreshed conflict", async () => {
  const baseData = data("Base");
  const baseCloud = await snapshot(baseData, "r1");
  const latestCloud = await snapshot(data("Other client"), "r2", "r1");
  const state = setup({
    local: data("This client"),
    baseline: baseline(baseCloud),
    remoteText: JSON.stringify(baseCloud),
  });
  state.client.remoteEtag = '"etag-r1"';
  state.client.onMove = () => {
    state.client.onMove = null;
    state.client.remoteText = JSON.stringify(latestCloud);
    state.client.remoteEtag = '"etag-r2"';
    state.client.moveError = new WebDavError("REMOTE_CAS_MISMATCH", 412);
  };

  const result = await state.coordinator.execute();

  assert.equal("decision" in result && result.decision, "conflict");
  if (!("decision" in result)) assert.fail("expected conflict");
  assert.equal(result.reason, "REMOTE_CAS_MISMATCH");
  assert.equal(result.cloud?.revision, "r2");
  const move = state.client.calls.find(
    (call): call is Extract<ClientCall, { method: "move" }> => call.method === "move",
  );
  assert.deepEqual(move?.precondition, { kind: "match", etag: '"etag-r1"' });
  assert.equal(state.baseline()?.revision, "r1");
});

test("first remote creation uses a missing-resource precondition", async () => {
  const state = setup({ remoteText: null });

  await state.coordinator.execute();

  const move = state.client.calls.find(
    (call): call is Extract<ClientCall, { method: "move" }> => call.method === "move",
  );
  assert.deepEqual(move?.precondition, { kind: "missing" });
});

test("an existing remote without an ETag is never overwritten", async () => {
  const baseData = data("Base");
  const cloud = await snapshot(baseData, "r1");
  const state = setup({
    local: data("Changed"),
    baseline: baseline(cloud),
    remoteText: JSON.stringify(cloud),
  });
  state.client.remoteEtag = null;

  const result = await state.coordinator.execute();
  assert.equal("decision" in result && result.decision, "conflict");
  if (!("decision" in result)) assert.fail("expected conflict");
  assert.equal(result.reason, "REMOTE_CAS_MISMATCH");
  assert.equal(state.client.calls.some((call) => call.method === "move"), false);
  assert.equal(state.client.calls.some(
    (call) => call.method === "putText" && call.path === FINAL_PATH,
  ), false);
});

test("MOVE_UNSUPPORTED fallback keeps the same remote CAS precondition", async () => {
  const baseData = data("Base");
  const cloud = await snapshot(baseData, "r1");
  const state = setup({
    local: data("Changed"),
    baseline: baseline(cloud),
    remoteText: JSON.stringify(cloud),
  });
  state.client.remoteEtag = '"etag-r1"';
  state.client.moveError = new WebDavError("MOVE_UNSUPPORTED", 405);

  await state.coordinator.execute();

  const finalPut = state.client.calls.find(
    (call): call is Extract<ClientCall, { method: "putText" }> =>
      call.method === "putText" && call.path === FINAL_PATH,
  );
  assert.deepEqual(finalPut?.precondition, { kind: "match", etag: '"etag-r1"' });
});

test("temp cleanup uses an independent live signal after the business request is aborted", async () => {
  const state = setup({ remoteText: null });
  const business = new AbortController();
  state.client.onMove = () => {
    business.abort();
    state.client.moveError = new WebDavError("ABORTED");
  };

  await assert.rejects(() => state.coordinator.execute(business.signal));

  const cleanup = state.client.calls.find(
    (call): call is Extract<ClientCall, { method: "delete" }> => call.method === "delete",
  );
  assert.ok(cleanup?.signal);
  assert.notEqual(cleanup.signal, business.signal);
  assert.equal(cleanup.signal.aborted, false);
});

test("keepLocal revalidates the dialog ETag and never overwrites a newer cloud snapshot", async () => {
  const shown = await snapshot(data("Shown"), "r1");
  const latest = await snapshot(data("Changed after dialog"), "r2", "r1");
  const state = setup({ local: data("Local"), remoteText: JSON.stringify(latest) });
  state.client.remoteEtag = '"etag-r2"';

  const result = await state.coordinator.keepLocal(shown, '"etag-r1"');

  assert.equal("decision" in result && result.decision, "conflict");
  if (!("decision" in result)) assert.fail("expected conflict");
  assert.equal(result.reason, "REMOTE_CAS_MISMATCH");
  assert.equal(result.cloud?.revision, "r2");
  assert.equal(state.client.calls.some((call) => call.method === "move"), false);
});


test("two clients uploading from the same baseline allow one CAS write and refresh the loser", async () => {
  const baseData = data("Base");
  const baseCloud = await snapshot(baseData, "r1");
  const first = setup({
    local: data("Client A"),
    baseline: baseline(baseCloud),
    remoteText: JSON.stringify(baseCloud),
  });
  const second = setup({
    local: data("Client B"),
    baseline: baseline(baseCloud),
    remoteText: JSON.stringify(baseCloud),
  });
  first.client.remoteEtag = '"etag-r1"';
  second.client.remoteEtag = '"etag-r1"';
  let currentEtag = '"etag-r1"';
  first.client.onMove = () => {
    currentEtag = '"etag-r2"';
    const uploaded = first.client.calls.find(
      (call): call is Extract<ClientCall, { method: "putText" }> => call.method === "putText",
    );
    assert.ok(uploaded);
    first.client.remoteText = uploaded.content;
    second.client.remoteText = uploaded.content;
    first.client.remoteEtag = currentEtag;
    second.client.remoteEtag = currentEtag;
  };
  second.client.onMove = () => {
    const move = second.client.calls.find(
      (call): call is Extract<ClientCall, { method: "move" }> => call.method === "move",
    );
    if (move?.precondition?.kind === "match" && move.precondition.etag !== currentEtag) {
      second.client.moveError = new WebDavError("REMOTE_CAS_MISMATCH", 412);
    }
  };

  const [winner, loser] = await Promise.all([
    first.coordinator.execute(),
    second.coordinator.execute(),
  ]);

  assert.deepEqual(winner, { status: "uploaded", warning: null });
  assert.equal("decision" in loser && loser.decision, "conflict");
  if (!("decision" in loser)) assert.fail("expected conflict");
  assert.equal(loser.reason, "REMOTE_CAS_MISMATCH");
  assert.equal(loser.cloud?.data.resumes[0].title, "Client A");
  assert.equal(second.baseline()?.revision, "r1");
});

test("keepLocal defers when a conditional write gets 412 and refresh finds the remote deleted", async () => {
  const shown = await snapshot(data("Shown"), "r1");
  const originalLocal = data("Local");
  const state = setup({ local: originalLocal, remoteText: JSON.stringify(shown) });
  state.client.remoteEtag = '"etag-r1"';
  state.client.onMove = () => {
    state.client.onMove = null;
    state.client.remoteText = null;
    state.client.remoteEtag = null;
    state.client.moveError = new WebDavError("REMOTE_CAS_MISMATCH", 412);
  };

  const result = await state.coordinator.keepLocal(shown, '"etag-r1"');

  assert.deepEqual(result, {
    status: "deferred",
    warning: null,
    reason: "REMOTE_MISSING_AFTER_CAS",
  });
  assert.deepEqual(state.local(), originalLocal);
  assert.equal(state.baseline(), null);
  assert.equal(state.client.calls.filter((call) => call.method === "move").length, 1);
  assert.equal(
    state.client.calls.some((call) => call.method === "putText" && call.path === FINAL_PATH),
    false,
  );
});

test("keepLocal refreshes the latest conflict when a conditional write gets 423", async () => {
  const shown = await snapshot(data("Shown"), "r1");
  const latest = await snapshot(data("Changed during write"), "r2", "r1");
  const originalLocal = data("Local");
  const state = setup({ local: originalLocal, remoteText: JSON.stringify(shown) });
  state.client.remoteEtag = '"etag-r1"';
  state.client.onMove = () => {
    state.client.onMove = null;
    state.client.remoteText = JSON.stringify(latest);
    state.client.remoteEtag = '"etag-r2"';
    state.client.moveError = new WebDavError("REMOTE_CAS_MISMATCH", 423);
  };

  const result = await state.coordinator.keepLocal(shown, '"etag-r1"');

  assert.equal("decision" in result && result.decision, "conflict");
  if (!("decision" in result)) assert.fail("expected conflict");
  assert.equal(result.reason, "REMOTE_CAS_MISMATCH");
  assert.equal(result.cloud?.revision, "r2");
  assert.equal(result.remoteEtag, '"etag-r2"');
  assert.deepEqual(state.local(), originalLocal);
  assert.equal(state.baseline(), null);
  assert.equal(state.client.calls.filter((call) => call.method === "move").length, 1);
  assert.equal(
    state.client.calls.some((call) => call.method === "putText" && call.path === FINAL_PATH),
    false,
  );
});

test("continuous local changes with a missing remote defer after three bounded inspections", async () => {
  const state = setup({ local: data("Local 0"), remoteText: null });
  let edit = 0;
  state.onLocalRead(() => {
    edit += 1;
    state.editLocal(data(`Local ${edit}`));
  });

  const result = await state.coordinator.execute();

  assert.deepEqual(result, {
    status: "deferred",
    warning: null,
    reason: "LOCAL_UNSTABLE",
  });
  assert.equal(
    state.client.calls.filter((call) => call.method === "getText").length,
    3,
  );
  assert.equal(state.client.calls.some((call) => call.method === "move"), false);
  assert.equal(state.baseline(), null);
});
