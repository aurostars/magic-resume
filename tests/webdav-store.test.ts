import assert from "node:assert/strict";
import test from "node:test";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { CloudSnapshotV1 } from "../src/lib/webdav/types";
import { useResumeStore } from "../src/store/useResumeStore";
import {
  createDefaultWebDavState,
  createWebDavStore,
  selectPersistedWebDavState,
  type PersistedWebDavState,
} from "../src/store/useWebDavStore";

useResumeStore.persist.setOptions({
  storage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});

const baseline = {
  manifestRevision: 1,
  manifestHash: "a".repeat(64),
  activeResumeId: null,
  entries: {
    deleted: {
      contentHash: "d".repeat(64),
      deleted: true,
      path: "trash/Deleted--delete.json",
    },
  },
};

const snapshot = {
  schemaVersion: 1,
  revision: "cloud-revision",
  parentRevision: null,
  updatedAt: "2026-09-12T12:01:00.000Z",
  deviceId: "cloud-device",
  contentHash: "b".repeat(64),
  data: { resumes: [], activeResumeId: null },
} satisfies CloudSnapshotV1;

const conflictSide = {
  updatedAt: "2026-09-12T12:01:00.000Z",
  deviceId: "device-1",
  resumeCount: 0,
};

function memoryStorage(initial?: StorageValue<PersistedWebDavState>) {
  let value = initial;
  const storage: PersistStorage<PersistedWebDavState> = {
    getItem: () => value ?? null,
    setItem: (_name, next) => { value = structuredClone(next); },
    removeItem: () => { value = undefined; },
  };
  return { storage, read: () => value };
}

test("new WebDAV settings enable automatic sync by default after empty hydration", async () => {
  const store = createWebDavStore(memoryStorage().storage);

  await store.persist.rehydrate();

  assert.equal(store.getState().settings.autoSyncEnabled, true);
});

test("persisted false keeps automatic sync disabled", async () => {
  const memory = memoryStorage({
    state: {
      settings: {
        baseUrl: "https://dav.jianguoyun.com/dav/",
        username: "account@example.test",
        password: "app-password",
        remoteDirectory: "/magic-resume/",
        autoSyncEnabled: false,
      },
      deviceId: "device-existing",
    },
    version: 0,
  });
  const store = createWebDavStore(memory.storage);

  await store.persist.rehydrate();

  assert.equal(store.getState().settings.autoSyncEnabled, false);
});

test("persisted automatic sync accepts only booleans and otherwise uses the default", async () => {
  for (const [persistedValue, expected] of [
    [true, true],
    [false, false],
    [undefined, true],
    [null, true],
    ["false", true],
    [0, true],
    [{ enabled: false }, true],
  ] as const) {
    const memory = memoryStorage({
      state: {
        settings: {
          baseUrl: "https://dav.example.test/root",
          username: "account@example.test",
          password: "app-password",
          remoteDirectory: "/legacy/",
          autoSyncEnabled: persistedValue,
        },
        deviceId: "device-legacy",
      },
      version: 0,
    } as unknown as StorageValue<PersistedWebDavState>);
    const store = createWebDavStore(memory.storage);

    await store.persist.rehydrate();

    assert.equal(store.getState().settings.autoSyncEnabled, expected);
    assert.equal(store.getState().settings.baseUrl, "https://dav.example.test/root");
  }
});

test("persisted settings without the auto-sync field receive the new default", async () => {
  const legacy = memoryStorage({
    state: {
      settings: {
        baseUrl: "https://dav.jianguoyun.com/dav/",
        username: "account@example.test",
        password: "app-password",
        remoteDirectory: "/legacy/",
      },
      deviceId: "device-legacy",
    },
    version: 0,
  } as unknown as StorageValue<PersistedWebDavState>);
  const store = createWebDavStore(legacy.storage);

  await store.persist.rehydrate();

  assert.deepEqual(store.getState().settings, {
    baseUrl: "https://dav.jianguoyun.com/dav/",
    username: "account@example.test",
    password: "app-password",
    remoteDirectory: "/legacy/",
    autoSyncEnabled: true,
  });
  assert.equal(store.getState().deviceId, "device-legacy");
});

test("defaults use the app directory and keep one generated device ID", () => {
  const store = createWebDavStore(memoryStorage().storage);
  const originalDeviceId = store.getState().deviceId;

  assert.deepEqual(store.getState().settings, {
    baseUrl: "",
    username: "",
    password: "",
    remoteDirectory: "/magic-resume/",
    autoSyncEnabled: true,
  });
  assert.ok(originalDeviceId.length > 0);
  store.getState().setSettings({ baseUrl: "https://dav.example.test" });
  store.getState().clearCredentials();
  assert.equal(store.getState().deviceId, originalDeviceId);
  assert.equal(store.getState().settings.autoSyncEnabled, true);
});

test("credentials, settings, and device ID are persisted and rehydrated without baseline", async () => {
  const memory = memoryStorage();
  const first = createWebDavStore(memory.storage);
  const deviceId = first.getState().deviceId;
  first.getState().setSettings({
    baseUrl: "https://dav.example.test",
    username: "dongxing.123",
    password: "secret",
    remoteDirectory: "/private/",
  });
  first.getState().setAutoSyncEnabled(true);

  const stored = memory.read();
  assert.deepEqual(stored?.state, {
    settings: {
      baseUrl: "https://dav.example.test",
      username: "dongxing.123",
      password: "secret",
      remoteDirectory: "/private/",
      autoSyncEnabled: true,
    },
    deviceId,
  });

  const restored = createWebDavStore(memory.storage);
  await restored.persist.rehydrate();
  assert.deepEqual(selectPersistedWebDavState(restored.getState()), stored?.state);
});

test("legacy aggregate baseline is discarded while settings and device ID rehydrate", async () => {
  useResumeStore.setState({ webDavBaseline: null });
  const resumeStateBefore = useResumeStore.getState();
  const legacy = memoryStorage({
    state: {
      settings: {
        baseUrl: "https://legacy.example.test",
        username: "dongxing.123",
        password: "legacy-secret",
        remoteDirectory: "/legacy/",
        autoSyncEnabled: true,
      },
      deviceId: "legacy-device",
      baseline: {
        revision: "aggregate-revision",
        contentHash: "f".repeat(64),
        syncedAt: "2026-09-12T12:00:00.000Z",
      },
    } as PersistedWebDavState,
    version: 0,
  });
  const store = createWebDavStore(legacy.storage);

  await store.persist.rehydrate();

  assert.deepEqual(store.getState().settings, {
    baseUrl: "https://legacy.example.test",
    username: "dongxing.123",
    password: "legacy-secret",
    remoteDirectory: "/legacy/",
    autoSyncEnabled: true,
  });
  assert.equal(store.getState().deviceId, "legacy-device");
  assert.equal("baseline" in store.getState(), false);
  assert.equal(useResumeStore.getState(), resumeStateBefore);
  assert.equal(useResumeStore.getState().getWebDavBaseline(), null);
});

test("persisted WebDAV state excludes all runtime state", () => {
  const partial = selectPersistedWebDavState({
    ...createDefaultWebDavState("device-1"),
    isSyncing: true,
    status: "error",
    conflict: { local: conflictSide, cloud: conflictSide, snapshot },
    abortController: new AbortController(),
    warning: { code: "MOVE_UNSUPPORTED", status: 405 },
    error: { code: "AUTH", status: 401 },
  });

  assert.deepEqual(Object.keys(partial).sort(), ["deviceId", "settings"]);
  for (const key of ["baseline", "isSyncing", "status", "conflict", "abortController", "warning", "error"])
    assert.equal(key in partial, false);
});

test("request and transient actions form a safe runtime state machine", () => {
  const store = createWebDavStore(memoryStorage().storage);
  const controller = new AbortController();
  store.getState().beginRequest(controller, "testing");
  assert.equal(store.getState().isSyncing, true);
  assert.equal(store.getState().status, "testing");
  assert.equal(store.getState().abortController, controller);

  store.getState().setConflict({ local: conflictSide, cloud: conflictSide, snapshot });
  store.getState().setWarning({ code: "MOVE_UNSUPPORTED", status: 405 });
  store.getState().setError({ code: "AUTH", status: 401 });
  assert.deepEqual(store.getState().error, { code: "AUTH", status: 401 });
  assert.deepEqual(Object.keys(store.getState().error ?? {}).sort(), ["code", "status"]);

  store.getState().finishRequest("success");
  assert.equal(store.getState().isSyncing, false);
  assert.equal(store.getState().abortController, null);
  assert.equal(store.getState().status, "success");
  store.getState().clearTransientState();
  assert.equal(store.getState().status, "idle");
  assert.equal(store.getState().conflict, null);
  assert.equal(store.getState().warning, null);
  assert.equal(store.getState().error, null);
});

test("error and warning actions discard extra sensitive diagnostic fields", () => {
  const store = createWebDavStore(memoryStorage().storage);
  const unsafeError = {
    code: "AUTH" as const,
    status: 401,
    message: "password=secret",
    stack: "private stack",
    rawError: new Error("private server response"),
  };
  const unsafeWarning = {
    code: "MOVE_UNSUPPORTED" as const,
    status: 405,
    message: "https://dav.example.test/?token=secret",
    stack: "private warning stack",
    rawError: new Error("private warning response"),
  };

  store.getState().setError(unsafeError);
  store.getState().setWarning(unsafeWarning);

  assert.deepEqual(store.getState().error, { code: "AUTH", status: 401 });
  assert.deepEqual(store.getState().warning, {
    code: "MOVE_UNSUPPORTED",
    status: 405,
  });
});

test("clearCredentials aborts first, clears persisted and transient sync data, and preserves device ID", () => {
  const store = createWebDavStore(memoryStorage().storage);
  const deviceId = store.getState().deviceId;
  const controller = new AbortController();
  let stateSeenOnAbort: ReturnType<typeof store.getState> | undefined;
  controller.signal.addEventListener("abort", () => { stateSeenOnAbort = store.getState(); });
  store.getState().setSettings({
    baseUrl: "https://dav.example.test",
    username: "dongxing.123",
    password: "secret",
    remoteDirectory: "/private/",
  });
  store.getState().setAutoSyncEnabled(true);
  const preservedResumes = useResumeStore.getState().resumes;
  useResumeStore.setState({ webDavBaseline: baseline });
  store.getState().beginRequest(controller);
  store.getState().setConflict({ local: conflictSide, cloud: conflictSide, snapshot });
  store.getState().setWarning({ code: "MOVE_UNSUPPORTED", status: 405 });
  store.getState().setError({ code: "AUTH", status: 401 });

  store.getState().clearCredentials();

  assert.equal(controller.signal.aborted, true);
  assert.equal(stateSeenOnAbort?.settings.password, "secret");
  const state = store.getState();
  assert.equal(state.deviceId, deviceId);
  assert.deepEqual(state.settings, createDefaultWebDavState(deviceId).settings);
  assert.equal(useResumeStore.getState().getWebDavBaseline(), null);
  assert.equal(useResumeStore.getState().resumes, preservedResumes);
  assert.equal(state.abortController, null);
  assert.equal(state.isSyncing, false);
  assert.equal(state.conflict, null);
  assert.equal(state.warning, null);
  assert.equal(state.error, null);
  assert.equal(state.status, "idle");
});
