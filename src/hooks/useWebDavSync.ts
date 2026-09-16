import { useEffect } from "react";
import { WEB_DAV_REQUEST_TIMEOUT_MS, WebDavClient } from "../lib/webdav/client";
import { WebDavResumeRepository } from "../lib/webdav/repository";
import { LocalCasMismatchError, WebDavError } from "../lib/webdav/errors";
import { WebDavSyncCoordinator } from "../lib/webdav/coordinator";
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
  type WebDavSafeError,
  type WebDavSettings,
  type WebDavStatus,
} from "../store/useWebDavStore";

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
  isRequestActive?(): boolean;
  subscribeRequest?(listener: (active: boolean, previousActive: boolean) => void): () => void;
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
      timeoutMs: WEB_DAV_REQUEST_TIMEOUT_MS,
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

  let leasedRequest: AbortController | null = null;
  const ownsRequest = (): boolean => Boolean(
    leasedRequest && useWebDavStore.getState().abortController === leasedRequest,
  );
  const finishOwnedRequest = (status: WebDavStatus): boolean => {
    if (!leasedRequest) return false;
    const finished = useWebDavStore.getState().finishRequest(leasedRequest, status);
    if (finished) leasedRequest = null;
    return finished;
  };

  return new WebDavSyncController({
    client,
    coordinator,
    remoteDirectory: settings.remoteDirectory,
    isApplyingRemote: () => useResumeStore.getState()._isApplyingSyncSnapshot,
    state: {
      isConfigured: () => isConfigured(useWebDavStore.getState().settings),
      isHydrated: () => useResumeStore.getState()._hasHydrated,
      isAutoSyncEnabled: () => useWebDavStore.getState().settings.autoSyncEnabled,
      isOnline: () => typeof navigator === "undefined" || navigator.onLine,
      isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
      hasConflict: () => useWebDavStore.getState().conflicts.length > 0,
      isRequestActive: () => useWebDavStore.getState().abortController !== null,
      begin: (requestController) => {
        const acquired = useWebDavStore.getState().beginRequest(requestController);
        if (acquired) leasedRequest = requestController;
        return acquired;
      },
      cancel: (requestController) => {
        if (leasedRequest !== requestController) return;
        finishOwnedRequest("idle");
      },
      complete: (warning, syncedCount) => {
        if (!ownsRequest()) return;
        const store = useWebDavStore.getState();
        if (syncedCount !== undefined) store.completeSync(syncedCount);
        if (warning) {
          store.setWarning({ code: "MOVE_UNSUPPORTED", status: null });
          finishOwnedRequest("warning");
        } else {
          store.setWarning(null);
          finishOwnedRequest("success");
        }
      },
      defer: () => {
        if (!ownsRequest()) return;
        const store = useWebDavStore.getState();
        store.setWarning(null);
        finishOwnedRequest("idle");
      },
      fail: (error) => {
        if (!ownsRequest()) return;
        const store = useWebDavStore.getState();
        store.setError(toSafeError(error));
        finishOwnedRequest("error");
      },
      setConflicts: (conflicts) => {
        if (!ownsRequest()) return;
        const store = useWebDavStore.getState();
        store.setConflicts(conflicts);
        finishOwnedRequest("conflict");
      },
      clearConflict: () => {
        if (ownsRequest()) useWebDavStore.getState().setConflicts([]);
      },
    },
  });
};

const browserLifecycleDependencies = (): WebDavLifecycleDependencies => ({
  windowTarget: window,
  documentTarget: document,
  getResumeState: () => useResumeStore.getState(),
  subscribeResume: (listener) => useResumeStore.subscribe(listener),
  isAutoSyncEnabled: () => useWebDavStore.getState().settings.autoSyncEnabled,
  isRequestActive: () => useWebDavStore.getState().abortController !== null,
  subscribeRequest: (listener) => useWebDavStore.subscribe((state, previous) => {
    listener(state.abortController !== null, previous.abortController !== null);
  }),
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
  let deferredAutoSync = hydrated &&
    dependencies.isAutoSyncEnabled() &&
    (dependencies.isRequestActive?.() ?? false);
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
          if (
            dependencies.isAutoSyncEnabled() &&
            (dependencies.isRequestActive?.() ?? false)
          ) deferredAutoSync = true;
          controller.notifyLocalChange();
        }
      })
    : null;

  const unsubscribeRequest = dependencies.subscribeRequest?.((active, previousActive) => {
    if (!deferredAutoSync || active || !previousActive) return;
    deferredAutoSync = false;
    queueMicrotask(() => { void controller.syncNow("automatic"); });
  });

  if (hydrated && dependencies.isAutoSyncEnabled() && !deferredAutoSync) {
    void controller.syncNow("automatic");
  }

  return () => {
    dependencies.windowTarget.removeEventListener("online", onOnline);
    dependencies.documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribe?.();
    unsubscribeRequest?.();
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
