import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { canonicalizeSyncData } from "../src/lib/webdav/snapshot";
import { initialResumeState } from "../src/config/initialResumeData";
import {
  shouldPushHistoryEntry,
} from "../src/store/resumeHistory";
import { useResumeStore } from "../src/store/useResumeStore";
import type { ResumeData } from "../src/types/resume";

function makeResume(overrides: Partial<ResumeData> = {}): ResumeData {
  return {
    ...structuredClone(initialResumeState),
    id: "resume-webdav-test",
    title: "董星 Resume",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    templateId: "classic",
    ...overrides,
  } as ResumeData;
}

beforeEach(() => {
  useResumeStore.setState({
    resumes: {},
    activeResumeId: null,
    activeResume: null,
    history: {},
    future: {},
    _hasHydrated: false,
    _isApplyingSyncSnapshot: false,
    webDavBaseline: null,
  });
});

test("getSyncSnapshot returns an ID-sorted deep clone", () => {
  const alpha = makeResume({ id: "alpha", title: "Alpha" });
  const beta = makeResume({ id: "beta", title: "Beta" });
  useResumeStore.setState({
    resumes: { beta, alpha },
    activeResumeId: "beta",
    activeResume: beta,
  });

  const snapshot = useResumeStore.getState().getSyncSnapshot();

  assert.deepEqual(snapshot.resumes.map((resume) => resume.id), ["alpha", "beta"]);
  assert.equal(snapshot.activeResumeId, "beta");
  snapshot.resumes[0].title = "Mutated outside store";
  snapshot.resumes[0].basic.name = "Mutated nested value";
  assert.equal(useResumeStore.getState().resumes.alpha.title, "Alpha");
  assert.notEqual(useResumeStore.getState().resumes.alpha.basic.name, "Mutated nested value");
});

test("applySyncSnapshot atomically replaces all synchronized resume state", () => {
  const old = makeResume({ id: "old", title: "Old" });
  useResumeStore.setState({
    resumes: { old },
    activeResumeId: "old",
    activeResume: old,
    history: { old: [structuredClone(old)] },
    future: { old: [structuredClone(old)] },
  });
  const alpha = makeResume({ id: "alpha", title: "Alpha" });
  const beta = makeResume({ id: "beta", title: "Beta" });
  let updates = 0;
  const unsubscribe = useResumeStore.subscribe(() => {
    updates += 1;
  });

  useResumeStore
    .getState()
    .applySyncSnapshot({ resumes: [beta, alpha], activeResumeId: "missing" });
  unsubscribe();

  const state = useResumeStore.getState();
  assert.equal(updates, 2);
  assert.deepEqual(Object.keys(state.resumes), ["alpha", "beta"]);
  assert.equal(state.activeResumeId, "alpha");
  assert.equal(state.activeResume, state.resumes.alpha);
  assert.deepEqual(state.history, {});
  assert.deepEqual(state.future, {});
});

test("applySyncSnapshot clones input and clears old and imported history groups", () => {
  const old = makeResume({ id: "old" });
  const incoming = makeResume({ id: "new" });
  useResumeStore.setState({ resumes: { old }, activeResumeId: "old", activeResume: old });
  assert.equal(shouldPushHistoryEntry("old", "title"), true);
  assert.equal(shouldPushHistoryEntry("new", "title"), true);

  useResumeStore
    .getState()
    .applySyncSnapshot({ resumes: [incoming], activeResumeId: "new" });

  incoming.title = "Mutated input";
  assert.notEqual(useResumeStore.getState().resumes.new.title, "Mutated input");
  assert.equal(shouldPushHistoryEntry("old", "title"), true);
  assert.equal(shouldPushHistoryEntry("new", "title"), true);
});

test("apply notification distinguishes remote restoration from an ordinary local change", () => {
  const remoteFlags: boolean[] = [];
  const unsubscribe = useResumeStore.subscribe((state) => {
    remoteFlags.push(state._isApplyingSyncSnapshot);
  });

  useResumeStore.getState().applySyncSnapshot({
    resumes: [makeResume({ id: "remote" })],
    activeResumeId: "remote",
  });
  useResumeStore.setState({ activeResumeId: "remote" });
  unsubscribe();

  assert.deepEqual(remoteFlags, [true, false, false]);
  assert.equal(useResumeStore.getState()._isApplyingSyncSnapshot, false);
});

test("persist rehydration toggles runtime hydration state without persisting it", async () => {
  const originalOptions = useResumeStore.persist.getOptions();
  const hydrated = makeResume({ id: "hydrated" });
  useResumeStore.persist.setOptions({
    storage: {
      getItem: async () => ({
        state: { resumes: { hydrated }, activeResumeId: "hydrated" },
        version: 0,
      }),
      setItem: async () => {},
      removeItem: async () => {},
    },
  });

  try {
    assert.equal(useResumeStore.getState()._hasHydrated, false);
    await useResumeStore.persist.rehydrate();
    assert.equal(useResumeStore.getState()._hasHydrated, true);
    assert.equal(useResumeStore.getState().activeResume, hydrated);

    const partialize = useResumeStore.persist.getOptions().partialize;
    assert.ok(partialize);
    const persisted = partialize(useResumeStore.getState());
    assert.deepEqual(Object.keys(persisted).sort(), [
      "activeResumeId",
      "resumes",
      "webDavBaseline",
    ]);
    assert.equal("_hasHydrated" in persisted, false);
    assert.equal("_isApplyingSyncSnapshot" in persisted, false);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("commitWebDavSnapshot publishes matching snapshot and baseline in one guarded notification", () => {
  const local = makeResume({ id: "local", title: "Local" });
  const remote = makeResume({ id: "remote", title: "Remote" });
  const nextBaseline = {
    revision: "r2",
    contentHash: "b".repeat(64),
    syncedAt: "2026-09-12T12:00:00.000Z",
  };
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: { revision: "r1", contentHash: "a".repeat(64), syncedAt: "old" },
  });
  const observations: Array<{ ids: string[]; revision: string | null; applying: boolean }> = [];
  const snapshotSubscriberReads: Array<{ ids: string[]; revision: string | null }> = [];
  const baselineSubscriberReads: Array<{ ids: string[]; revision: string | null }> = [];
  const unsubscribe = useResumeStore.subscribe((state, previous) => {
    if (
      state.resumes !== previous.resumes ||
      state.webDavBaseline !== previous.webDavBaseline ||
      state._isApplyingSyncSnapshot !== previous._isApplyingSyncSnapshot
    ) {
      observations.push({
        ids: Object.keys(state.resumes),
        revision: state.webDavBaseline?.revision ?? null,
        applying: state._isApplyingSyncSnapshot,
      });
    }
  });
  const unsubscribeSnapshot = useResumeStore.subscribe((state, previous) => {
    if (state.resumes !== previous.resumes) {
      snapshotSubscriberReads.push({
        ids: Object.keys(state.resumes),
        revision: state.webDavBaseline?.revision ?? null,
      });
    }
  });
  const unsubscribeBaseline = useResumeStore.subscribe((state, previous) => {
    if (state.webDavBaseline !== previous.webDavBaseline) {
      baselineSubscriberReads.push({
        ids: Object.keys(state.resumes),
        revision: state.webDavBaseline?.revision ?? null,
      });
    }
  });

  useResumeStore.getState().commitWebDavSnapshot(
    { resumes: [remote], activeResumeId: "remote" },
    nextBaseline,
    canonicalizeSyncData({ resumes: [local], activeResumeId: "local" }),
  );
  unsubscribe();
  unsubscribeSnapshot();
  unsubscribeBaseline();

  assert.deepEqual(observations, [
    { ids: ["remote"], revision: "r2", applying: true },
    { ids: ["remote"], revision: "r2", applying: false },
  ]);
  assert.deepEqual(snapshotSubscriberReads, [
    { ids: ["remote"], revision: "r2" },
  ]);
  assert.deepEqual(baselineSubscriberReads, [
    { ids: ["remote"], revision: "r2" },
  ]);
  assert.equal(useResumeStore.getState()._isApplyingSyncSnapshot, false);
});

test("commitWebDavSnapshot CAS mismatch changes nothing and emits no notification", () => {
  const local = makeResume({ id: "local" });
  const oldBaseline = { revision: "r1", contentHash: "a".repeat(64), syncedAt: "old" };
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: oldBaseline,
  });
  let notifications = 0;
  const unsubscribe = useResumeStore.subscribe(() => { notifications += 1; });

  assert.throws(() => useResumeStore.getState().commitWebDavSnapshot(
    { resumes: [makeResume({ id: "remote" })], activeResumeId: "remote" },
    { revision: "r2", contentHash: "b".repeat(64), syncedAt: "new" },
    "stale-token",
  ), { name: "LocalCasMismatchError" });
  unsubscribe();

  assert.deepEqual(Object.keys(useResumeStore.getState().resumes), ["local"]);
  assert.equal(useResumeStore.getState().webDavBaseline, oldBaseline);
  assert.equal(useResumeStore.getState()._isApplyingSyncSnapshot, false);
  assert.equal(notifications, 0);
});

test("rehydration restores resume snapshot and WebDAV baseline from one persisted value", async () => {
  const originalOptions = useResumeStore.persist.getOptions();
  const hydrated = makeResume({ id: "hydrated" });
  const hydratedBaseline = {
    revision: "r7",
    contentHash: "c".repeat(64),
    syncedAt: "2026-09-12T12:00:00.000Z",
  };
  useResumeStore.persist.setOptions({
    storage: {
      getItem: async () => ({
        state: {
          resumes: { hydrated },
          activeResumeId: "hydrated",
          webDavBaseline: hydratedBaseline,
        },
        version: 0,
      }),
      setItem: async () => {},
      removeItem: async () => {},
    },
  });

  try {
    await useResumeStore.persist.rehydrate();
    const state = useResumeStore.getState();
    assert.equal(state.activeResume, hydrated);
    assert.equal(state.webDavBaseline, hydratedBaseline);
    const persisted = useResumeStore.persist.getOptions().partialize?.(state);
    assert.deepEqual(Object.keys(persisted ?? {}).sort(), [
      "activeResumeId",
      "resumes",
      "webDavBaseline",
    ]);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("commitWebDavSnapshot resets guard when a real subscriber throws", () => {
  const local = makeResume({ id: "local" });
  const remote = makeResume({ id: "remote" });
  const nextBaseline = { revision: "r2", contentHash: "b".repeat(64), syncedAt: "new" };
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: null,
  });
  const unsubscribe = useResumeStore.subscribe(() => {
    throw new Error("subscriber failed");
  });

  assert.throws(() => useResumeStore.getState().commitWebDavSnapshot(
    { resumes: [remote], activeResumeId: "remote" },
    nextBaseline,
    canonicalizeSyncData({ resumes: [local], activeResumeId: "local" }),
  ), /subscriber failed/);
  unsubscribe();

  const state = useResumeStore.getState();
  assert.equal(state._isApplyingSyncSnapshot, false);
  assert.deepEqual(Object.keys(state.resumes), ["remote"]);
  assert.equal(state.webDavBaseline, nextBaseline);
});

test("commitWebDavSnapshot resets guard when persistence throws", () => {
  const originalOptions = useResumeStore.persist.getOptions();
  const local = makeResume({ id: "local" });
  const remote = makeResume({ id: "remote" });
  const nextBaseline = { revision: "r2", contentHash: "b".repeat(64), syncedAt: "new" };
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: null,
  });
  useResumeStore.persist.setOptions({
    storage: {
      getItem: () => null,
      setItem: () => { throw new Error("persist failed"); },
      removeItem: () => {},
    },
  });

  try {
    assert.throws(() => useResumeStore.getState().commitWebDavSnapshot(
      { resumes: [remote], activeResumeId: "remote" },
      nextBaseline,
      canonicalizeSyncData({ resumes: [local], activeResumeId: "local" }),
    ), /persist failed/);
    const state = useResumeStore.getState();
    assert.equal(state._isApplyingSyncSnapshot, false);
    assert.deepEqual(Object.keys(state.resumes), ["remote"]);
    assert.equal(state.webDavBaseline, nextBaseline);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("applySyncSnapshot resets guard when a real subscriber throws", () => {
  const remote = makeResume({ id: "remote" });
  const baseline = { revision: "r1", contentHash: "a".repeat(64), syncedAt: "old" };
  useResumeStore.setState({ webDavBaseline: baseline });
  const unsubscribe = useResumeStore.subscribe(() => {
    throw new Error("subscriber failed");
  });

  assert.throws(() => useResumeStore.getState().applySyncSnapshot(
    { resumes: [remote], activeResumeId: "remote" },
  ), /subscriber failed/);
  unsubscribe();

  const state = useResumeStore.getState();
  assert.equal(state._isApplyingSyncSnapshot, false);
  assert.deepEqual(Object.keys(state.resumes), ["remote"]);
  assert.equal(state.webDavBaseline, baseline);
});

test("applySyncSnapshot resets guard when persistence throws", () => {
  const originalOptions = useResumeStore.persist.getOptions();
  const remote = makeResume({ id: "remote" });
  const baseline = { revision: "r1", contentHash: "a".repeat(64), syncedAt: "old" };
  useResumeStore.setState({ webDavBaseline: baseline });
  useResumeStore.persist.setOptions({
    storage: {
      getItem: () => null,
      setItem: () => { throw new Error("persist failed"); },
      removeItem: () => {},
    },
  });

  try {
    assert.throws(() => useResumeStore.getState().applySyncSnapshot(
      { resumes: [remote], activeResumeId: "remote" },
    ), /persist failed/);
    const state = useResumeStore.getState();
    assert.equal(state._isApplyingSyncSnapshot, false);
    assert.deepEqual(Object.keys(state.resumes), ["remote"]);
    assert.equal(state.webDavBaseline, baseline);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});
