import { useEffect } from "react";
import { WebDavClient } from "../lib/webdav/client";
import { WebDavResumeRepository } from "../lib/webdav/repository";
import { LocalCasMismatchError, WebDavError } from "../lib/webdav/errors";
import {
  WebDavSyncCoordinator,
  type SyncInspection,
} from "../lib/webdav/coordinator";
import { WebDavSyncController } from "../lib/webdav/controller";
import {
  ManifestValidationError,
  SnapshotValidationError,
  type MultiFileBaseline,
  type ResumeSyncData,
} from "../lib/webdav/types";
import { useResumeStore } from "../store/useResumeStore";
import {
  useWebDavStore,
  type WebDavConflict,
  type WebDavSafeError,
  type WebDavSettings,
} from "../store/useWebDavStore";

const REQUEST_TIMEOUT_MS = 15_000;

type ResumeLifecycleState = Pick<
  ReturnType<typeof useResumeStore.getState>,
  | "_hasHydrated"
  | "_isApplyingSyncSnapshot"
  | "resumes"
  | "activeResumeId"
>;

type LifecycleEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface WebDavLifecycleDependencies {
  windowTarget: LifecycleEventTarget;
  documentTarget: LifecycleEventTarget & Pick<Document, "visibilityState">;
  getResumeState(): ResumeLifecycleState;
  subscribeResume(
    listener: (state: ResumeLifecycleState, previous: ResumeLifecycleState) => void,
  ): () => void;
  isAutoSyncEnabled(): boolean;
}

let activeController: WebDavSyncController | null = null;

const isConfigured = (settings: WebDavSettings): boolean =>
  Boolean(
    settings.baseUrl.trim() &&
    settings.username.trim() &&
    settings.password &&
    settings.remoteDirectory.trim(),
  );

const toSafeError = (error: unknown): WebDavSafeError => {
  if (error instanceof WebDavError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof SnapshotValidationError || error instanceof ManifestValidationError) {
    return { code: error.code, status: null };
  }
  return { code: "UNKNOWN", status: null };
};

const latestResumeTimestamp = (data: ResumeSyncData): string =>
  data.resumes.reduce(
    (latest, resume) => resume.updatedAt > latest ? resume.updatedAt : latest,
    "1970-01-01T00:00:00.000Z",
  );

const createConflict = (
  inspection: Extract<SyncInspection, { decision: "conflict" }>,
  deviceId: string,
): WebDavConflict => {
  const conflict = inspection.conflicts[0];
  const manifest = inspection.manifest;
  if (!conflict || !manifest) throw new WebDavError("UNKNOWN");
  return {
    local: {
      updatedAt: latestResumeTimestamp(inspection.localData),
      deviceId,
      resumeCount: inspection.localData.resumes.length,
    },
    cloud: {
      updatedAt: manifest.updatedAt,
      deviceId: manifest.deviceId,
      resumeCount: Object.values(manifest.entries).filter((entry) => !entry.deleted).length,
    },
    snapshot: {
      schemaVersion: 1,
      revision: conflict.resumeId,
      parentRevision: null,
      updatedAt: manifest.updatedAt,
      deviceId: manifest.deviceId,
      contentHash: manifest.manifestHash,
      data: inspection.localData,
    },
    remoteEtag: inspection.remoteEtag,
    manifestRevision: manifest.revision,
  };
};

/** Commit the validated cloud data and its baseline inside the Resume Store transaction. */
export const commitDownloadedSnapshot = (
  data: ResumeSyncData,
  baseline: MultiFileBaseline,
  expectedLocalToken: string,
): void => {
  const committed = useResumeStore.getState().commitWebDavSync({
    data,
    baseline,
    expectedLocalToken,
  });
  if (!committed) throw new LocalCasMismatchError();
};

export const createConfiguredController = (
  settings: WebDavSettings,
  deviceId: string,
): WebDavSyncController | null => {
  if (!useResumeStore.getState()._hasHydrated || !isConfigured(settings)) return null;

  let client: WebDavClient;
  try {
    client = new WebDavClient({
      baseUrl: settings.baseUrl,
      username: settings.username,
      password: settings.password,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    useWebDavStore.getState().setError(toSafeError(error));
    return null;
  }
  const repository = new WebDavResumeRepository(client, {
    deviceId,
    remoteDirectory: settings.remoteDirectory,
  });
  const coordinator = new WebDavSyncCoordinator({
    repository,
    getLocalData: () => useResumeStore.getState().getSyncSnapshot(),
    subscribeLocalData: (listener) => useResumeStore.subscribe(listener),
    getBaseline: () => useResumeStore.getState().getWebDavBaseline(),
    commit: commitDownloadedSnapshot,
    deviceId,
    now: () => new Date().toISOString(),
  });

  return new WebDavSyncController({
    client,
    coordinator,
    remoteDirectory: settings.remoteDirectory,
    isApplyingRemote: () => useResumeStore.getState()._isApplyingSyncSnapshot,
    createConflict: (inspection) => createConflict(inspection, deviceId),
    state: {
      isConfigured: () => isConfigured(useWebDavStore.getState().settings),
      isHydrated: () => useResumeStore.getState()._hasHydrated,
      isAutoSyncEnabled: () => useWebDavStore.getState().settings.autoSyncEnabled,
      isOnline: () => typeof navigator === "undefined" || navigator.onLine,
      isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
      hasConflict: () => useWebDavStore.getState().conflict !== null,
      begin: (requestController) => useWebDavStore.getState().beginRequest(requestController),
      complete: (warning) => {
        const store = useWebDavStore.getState();
        if (warning) {
          store.setWarning({ code: "MOVE_UNSUPPORTED", status: null });
          store.finishRequest("warning");
        } else {
          store.setWarning(null);
          store.finishRequest("success");
        }
      },
      defer: () => {
        const store = useWebDavStore.getState();
        store.setWarning(null);
        store.finishRequest("idle");
      },
      fail: (error) => {
        const store = useWebDavStore.getState();
        store.finishRequest("error");
        store.setError(toSafeError(error));
      },
      setConflict: (conflict) => {
        const store = useWebDavStore.getState();
        store.finishRequest("conflict");
        store.setConflict(conflict);
      },
      clearConflict: () => useWebDavStore.getState().setConflict(null),
    },
  });
};

const browserLifecycleDependencies = (): WebDavLifecycleDependencies => ({
  windowTarget: window,
  documentTarget: document,
  getResumeState: () => useResumeStore.getState(),
  subscribeResume: (listener) => useResumeStore.subscribe(listener),
  isAutoSyncEnabled: () => useWebDavStore.getState().settings.autoSyncEnabled,
});

export const attachWebDavLifecycle = (
  controller: WebDavSyncController,
  dependencies: WebDavLifecycleDependencies = browserLifecycleDependencies(),
): (() => void) => {
  const onOnline = () => controller.notifyOnline();
  const onVisibilityChange = () => {
    if (dependencies.documentTarget.visibilityState === "visible") {
      controller.notifyVisible();
    }
  };
  dependencies.windowTarget.addEventListener("online", onOnline);
  dependencies.documentTarget.addEventListener("visibilitychange", onVisibilityChange);

  const hydrated = dependencies.getResumeState()._hasHydrated;
  const unsubscribe = hydrated
    ? dependencies.subscribeResume((state, previous) => {
        const snapshotChanged =
          state.resumes !== previous.resumes ||
          state.activeResumeId !== previous.activeResumeId;
        if (
          state._hasHydrated &&
          snapshotChanged &&
          !state._isApplyingSyncSnapshot
        ) {
          controller.notifyLocalChange();
        }
      })
    : null;

  if (hydrated && dependencies.isAutoSyncEnabled()) {
    void controller.syncNow("automatic");
  }

  return () => {
    dependencies.windowTarget.removeEventListener("online", onOnline);
    dependencies.documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribe?.();
    controller.dispose();
  };
};

export const getWebDavSyncController = (): WebDavSyncController | null => activeController;

export const useWebDavSync = (): void => {
  const hydrated = useResumeStore((state) => state._hasHydrated);
  const settings = useWebDavStore((state) => state.settings);
  const deviceId = useWebDavStore((state) => state.deviceId);

  useEffect(() => {
    if (!hydrated) {
      activeController = null;
      return;
    }
    const controller = createConfiguredController(settings, deviceId);
    activeController = controller;
    if (!controller) {
      return () => {
        if (activeController === controller) activeController = null;
      };
    }
    const detach = attachWebDavLifecycle(controller);
    return () => {
      detach();
      if (activeController === controller) activeController = null;
    };
  }, [hydrated, settings, deviceId]);
};
