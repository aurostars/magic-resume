import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { canonicalizeSyncData } from "../src/lib/webdav/snapshot";
import { initialResumeState } from "../src/config/initialResumeData";
import { shouldPushHistoryEntry } from "../src/store/resumeHistory";
import { useResumeStore } from "../src/store/useResumeStore";
import type { MultiFileBaseline } from "../src/lib/webdav/types";
import type { ResumeData } from "../src/types/resume";

const hash = (character: string): string => character.repeat(64);

const makeBaseline = (
  manifestRevision = 1,
  entries: MultiFileBaseline["entries"] = {
    alpha: {
      contentHash: hash("a"),
      deleted: false,
      path: "resumes/Alpha--alpha.json",
    },
    deleted: {
      contentHash: hash("d"),
      deleted: true,
      path: "trash/Deleted--delete.json",
    },
  },
): MultiFileBaseline => ({
  manifestRevision,
  manifestHash: hash("f"),
  activeResumeId: Object.entries(entries).find(([, entry]) => !entry.deleted)?.[0] ?? null,
  entries,
});

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
  useResumeStore.persist.setOptions({
    storage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
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
  const unsubscribe = useResumeStore.subscribe(() => { updates += 1; });

  useResumeStore.getState().applySyncSnapshot({
    resumes: [beta, alpha],
    activeResumeId: "missing",
  });
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

  useResumeStore.getState().applySyncSnapshot({
    resumes: [incoming],
    activeResumeId: "new",
  });

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
        version: 1,
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

    const persisted = useResumeStore.persist.getOptions().partialize?.(
      useResumeStore.getState(),
    );
    assert.deepEqual(Object.keys(persisted ?? {}).sort(), [
      "activeResumeId",
      "resumes",
      "webDavBaseline",
    ]);
    assert.equal("_hasHydrated" in (persisted ?? {}), false);
    assert.equal("_isApplyingSyncSnapshot" in (persisted ?? {}), false);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("persist and rehydrate preserve every multi-file baseline entry", async () => {
  const originalOptions = useResumeStore.persist.getOptions();
  const hydrated = makeResume({ id: "alpha", title: "Alpha" });
  const baseline = makeBaseline();
  useResumeStore.persist.setOptions({
    storage: {
      getItem: async () => ({
        state: {
          resumes: { alpha: hydrated },
          activeResumeId: "alpha",
          webDavBaseline: structuredClone(baseline),
        },
        version: 1,
      }),
      setItem: async () => {},
      removeItem: async () => {},
    },
  });

  try {
    await useResumeStore.persist.rehydrate();
    assert.deepEqual(useResumeStore.getState().getWebDavBaseline(), baseline);
    assert.deepEqual(Object.keys(useResumeStore.getState().getWebDavBaseline()?.entries ?? {}), [
      "alpha",
      "deleted",
    ]);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("migration discards an aggregate baseline while preserving resumes", async () => {
  const originalOptions = useResumeStore.persist.getOptions();
  const hydrated = makeResume({ id: "legacy" });
  useResumeStore.persist.setOptions({
    storage: {
      getItem: async () => ({
        state: {
          resumes: { legacy: hydrated },
          activeResumeId: "legacy",
          webDavBaseline: {
            revision: "old-revision",
            contentHash: hash("a"),
            syncedAt: "2026-09-12T12:00:00.000Z",
          },
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
    assert.equal(state.resumes.legacy, hydrated);
    assert.equal(state.activeResume, hydrated);
    assert.equal(state.getWebDavBaseline(), null);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("rehydration discards a malformed multi-file baseline without discarding resumes", async () => {
  const originalOptions = useResumeStore.persist.getOptions();
  const hydrated = makeResume({ id: "safe" });
  useResumeStore.persist.setOptions({
    storage: {
      getItem: async () => ({
        state: {
          resumes: { safe: hydrated },
          activeResumeId: "safe",
          webDavBaseline: {
            ...makeBaseline(),
            entries: {
              safe: { contentHash: "not-a-hash", deleted: false, path: "../escape.json" },
            },
          },
        },
        version: 1,
      }),
      setItem: async () => {},
      removeItem: async () => {},
    },
  });

  try {
    await useResumeStore.persist.rehydrate();
    const state = useResumeStore.getState();
    assert.equal(state.resumes.safe, hydrated);
    assert.equal(state.getWebDavBaseline(), null);
  } finally {
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("commitWebDavSync publishes matching resume data and baseline in one set", () => {
  const local = makeResume({ id: "local", title: "Local" });
  const remote = makeResume({ id: "remote", title: "Remote" });
  const nextBaseline = makeBaseline(2, {
    remote: { contentHash: hash("b"), deleted: false, path: "resumes/Remote--remote.json" },
  });
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: makeBaseline(),
  });
  const synchronizedObservations: Array<{ ids: string[]; revision: number | null }> = [];
  const unsubscribe = useResumeStore.subscribe((state, previous) => {
    if (state.resumes !== previous.resumes || state.webDavBaseline !== previous.webDavBaseline) {
      synchronizedObservations.push({
        ids: Object.keys(state.resumes),
        revision: state.getWebDavBaseline()?.manifestRevision ?? null,
      });
    }
  });

  const committed = useResumeStore.getState().commitWebDavSync({
    data: { resumes: [remote], activeResumeId: "remote" },
    baseline: nextBaseline,
    expectedLocalToken: canonicalizeSyncData({ resumes: [local], activeResumeId: "local" }),
  });
  unsubscribe();

  assert.equal(committed, true);
  assert.deepEqual(synchronizedObservations, [{ ids: ["remote"], revision: 2 }]);
  assert.equal(useResumeStore.getState()._isApplyingSyncSnapshot, false);
});

test("commitWebDavSync token mismatch returns false with zero mutation", () => {
  const local = makeResume({ id: "local" });
  const oldBaseline = makeBaseline();
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    history: { local: [structuredClone(local)] },
    future: { local: [structuredClone(local)] },
    webDavBaseline: oldBaseline,
    _isApplyingSyncSnapshot: true,
  });
  const before = useResumeStore.getState();
  const originalOptions = useResumeStore.persist.getOptions();
  let persistedWrites = 0;
  useResumeStore.persist.setOptions({
    storage: {
      getItem: () => null,
      setItem: () => { persistedWrites += 1; },
      removeItem: () => {},
    },
  });
  let notifications = 0;
  const unsubscribe = useResumeStore.subscribe(() => { notifications += 1; });

  try {
    const committed = useResumeStore.getState().commitWebDavSync({
      data: { resumes: [makeResume({ id: "remote" })], activeResumeId: "remote" },
      baseline: makeBaseline(2),
      expectedLocalToken: "stale-token",
    });

    const after = useResumeStore.getState();
    assert.equal(committed, false);
    assert.equal(after, before);
    assert.equal(after.webDavBaseline, oldBaseline);
    assert.equal(after._isApplyingSyncSnapshot, true);
    assert.equal(notifications, 0);
    assert.equal(persistedWrites, 0);
    assert.equal(shouldPushHistoryEntry("local", "title"), true);
  } finally {
    unsubscribe();
    useResumeStore.persist.setOptions(originalOptions);
  }
});

test("clearWebDavBaseline clears only the authoritative baseline", () => {
  const local = makeResume({ id: "local" });
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: makeBaseline(),
  });

  useResumeStore.getState().clearWebDavBaseline();

  const state = useResumeStore.getState();
  assert.equal(state.getWebDavBaseline(), null);
  assert.equal(state.resumes.local, local);
  assert.equal(state.activeResume, local);
});

test("commitWebDavSync restores the guard in finally when a subscriber throws", () => {
  const local = makeResume({ id: "local" });
  const remote = makeResume({ id: "remote" });
  const nextBaseline = makeBaseline(2);
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: null,
  });
  const unsubscribe = useResumeStore.subscribe(() => {
    throw new Error("subscriber failed");
  });

  assert.throws(() => useResumeStore.getState().commitWebDavSync({
    data: { resumes: [remote], activeResumeId: "remote" },
    baseline: nextBaseline,
    expectedLocalToken: canonicalizeSyncData({ resumes: [local], activeResumeId: "local" }),
  }), /subscriber failed/);
  unsubscribe();

  const state = useResumeStore.getState();
  assert.equal(state._isApplyingSyncSnapshot, false);
  assert.deepEqual(Object.keys(state.resumes), ["remote"]);
  assert.deepEqual(state.getWebDavBaseline(), nextBaseline);
});
