import { useEffect, useRef, useState } from "react";
import { Cloud, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getWebDavSyncController } from "@/hooks/useWebDavSync";
import { isJianguoyunWebDavUrl, normalizeWebDavBaseUrl } from "@/lib/webdav/client";
import { WebDavError } from "@/lib/webdav/errors";
import { getWebDavDiagnostic } from "@/lib/webdav/diagnostics";
import type { WebDavSyncController } from "@/lib/webdav/controller";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import {
  useWebDavStore,
  type WebDavSettings,
} from "@/store/useWebDavStore";
import { WebDavConflictDialog } from "./WebDavConflictDialog";

type ControllerApi = Pick<
  WebDavSyncController,
  "testConnection" | "syncNow" | "resolveConflict"
>;

export interface WebDavSectionProps {
  controllerProvider?: () => ControllerApi | null;
}

const normalizeDirectory = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}/`;
};

const normalizeSettings = (draft: WebDavSettings): WebDavSettings => ({
  ...draft,
  baseUrl: normalizeWebDavBaseUrl(draft.baseUrl).toString(),
  username: draft.username.trim(),
  remoteDirectory: normalizeDirectory(draft.remoteDirectory),
});

export const WebDavSection = ({
  controllerProvider = getWebDavSyncController,
}: WebDavSectionProps) => {
  const t = useTranslations("dashboard.settings.webdav");
  const locale = useLocale();
  const settings = useWebDavStore((state) => state.settings);
  const {
    isSyncing, status, error, warning, conflicts, syncedResumeCount, lastSyncedAt,
    setSettings, clearCredentials,
  } = useWebDavStore((state) => state);
  const [draft, setDraft] = useState(settings);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const clearCancelRef = useRef<HTMLButtonElement>(null);
  const clearTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => setDraft(settings), [settings]);

  const updateDraft = (field: keyof WebDavSettings, value: string | boolean) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const run = async (action: "test" | "sync") => {
    setPendingAction(action);
    try {
      let normalized: WebDavSettings;
      try {
        normalized = normalizeSettings(draft);
      } catch (caught) {
        const safeError = caught instanceof WebDavError
          ? caught
          : new WebDavError("UNKNOWN");
        useWebDavStore.getState().setError({
          code: safeError.code,
          status: safeError.status,
        });
        return;
      }
      setDraft(normalized);
      setSettings(normalized);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const controller = controllerProvider();
      if (!controller) {
        useWebDavStore.getState().setError({ code: "UNKNOWN", status: null });
        return;
      }
      if (action === "test") await controller.testConnection();
      else await controller.syncNow("manual");
    } catch (caught) {
      if (caught instanceof WebDavError) {
        useWebDavStore.getState().setError({
          code: caught.code,
          status: caught.status,
        });
      }
      // Other controller failures have already been reduced to safe store state.
    } finally {
      setPendingAction(null);
    }
  };

  const resolve = async (
    resumeId: string,
    resolution: "keep-local" | "use-cloud",
  ) => {
    setPendingAction(`resolve:${resumeId}`);
    try {
      await controllerProvider()?.resolveConflict(resumeId, resolution);
    } catch {
      // The controller has already reduced failures to safe store state.
    } finally {
      setPendingAction(null);
    }
  };

  const busy = isSyncing || pendingAction !== null;
  let jianguoyun = false;
  try {
    jianguoyun = isJianguoyunWebDavUrl(normalizeWebDavBaseUrl(draft.baseUrl));
  } catch {
    // Invalid drafts must retain generic, sanitized error guidance.
  }
  const diagnostic = error ? getWebDavDiagnostic(error, jianguoyun) : null;
  const statusMessage = diagnostic
    ? t(diagnostic.messageKey)
    : warning
      ? t("nonAtomicWarning")
      : status === "syncing" || status === "testing" || busy
        ? t("syncing")
        : status === "success"
          ? t("success")
          : null;

  return (
    <>
      <Card className="overflow-hidden border border-gray-200 shadow-sm dark:border-gray-800 dark:bg-gray-900/50">
        <CardHeader className="border-b border-gray-100 pb-6 dark:border-gray-800/50">
          <div className="flex items-start gap-4">
            <div className="shrink-0 rounded-xl bg-sky-50 p-3 dark:bg-sky-900/20">
              <Cloud className="h-6 w-6 text-sky-600" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <CardTitle className="text-xl">{t("title")}</CardTitle>
              <CardDescription className="text-base leading-relaxed">{t("description")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 p-6 md:p-8">
          <div className="grid gap-5 md:grid-cols-2">
            {([
              ["baseUrl", "webdav-server-url", "serverUrl", "url"],
              ["username", "webdav-username", "username", "text"],
              ["password", "webdav-password", "password", "password"],
              ["remoteDirectory", "webdav-remote-directory", "remoteDirectory", "text"],
            ] as const).map(([field, id, label, type]) => (
              <div className="space-y-2" key={field}>
                <Label htmlFor={id}>{t(label)}</Label>
                <Input
                  id={id}
                  type={type}
                  autoComplete={field === "password" ? "current-password" : undefined}
                  value={draft[field] as string}
                  disabled={busy}
                  onChange={(event) => updateDraft(field, event.target.value)}
                />
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
            <Label htmlFor="webdav-auto-sync" className="leading-normal">{t("autoSync")}</Label>
            <button
              id="webdav-auto-sync"
              type="button"
              role="switch"
              aria-label={t("autoSync")}
              aria-checked={draft.autoSyncEnabled}
              disabled={busy}
              className="relative h-6 w-11 rounded-full bg-gray-300 transition-colors aria-checked:bg-primary disabled:opacity-50 dark:bg-gray-700"
              onClick={() => {
                const checked = !draft.autoSyncEnabled;
                updateDraft("autoSyncEnabled", checked);
                setSettings({ autoSyncEnabled: checked });
              }}
            >
              <span className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform [[aria-checked=true]_&]:translate-x-5" />
            </button>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            <div className="flex gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div><p>{t("localStorageWarning")}</p><p className="mt-1">{t("dedicatedAccountHint")}</p></div>
            </div>
          </div>

          <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
            <p>{t("perResumeJsonDescription")}</p>
            <p>{t("credentialsLocalDescription")}</p>
            <p>{t("clearKeepsFilesDescription")}</p>
          </div>

          <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
            <p>{t("syncedResumeCount", { count: syncedResumeCount })}</p>
            <p>
              {lastSyncedAt ? t("lastSyncedAt", { time: new Date(lastSyncedAt).toLocaleString(locale) }) : t("neverSynced")}
            </p>
          </div>
          {statusMessage && (
            <div role={error ? "alert" : "status"} className={error ? "text-sm text-red-600" : "text-sm text-gray-600 dark:text-gray-300"}>
              <p>{statusMessage}</p>
              {diagnostic && (
                <p className="mt-1 text-xs">
                  {t("diagnosticLabel", { code: diagnostic.diagnosticCode })}
                  {diagnostic.httpStatus === null
                    ? null
                    : ` · ${t("httpStatusLabel", { status: diagnostic.httpStatus })}`}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" disabled={busy} onClick={() => run("test")}>{t("testConnection")}</Button>
            <Button type="button" disabled={busy} onClick={() => run("sync")}>{t("syncNow")}</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                clearTriggerRef.current = event.currentTarget;
                setShowClearConfirm(true);
              }}
            >
              {t("clearCredentials")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={showClearConfirm}
        onOpenChange={(open) => {
          if (!busy) setShowClearConfirm(open);
        }}
      >
        <DialogContent
          aria-modal="true"
          hideClose
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            clearCancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            clearTriggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("clearConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("clearConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:space-x-0">
            <Button
              ref={clearCancelRef}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setShowClearConfirm(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                clearCredentials();
                setShowClearConfirm(false);
              }}
            >
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WebDavConflictDialog
        conflict={conflicts[0] ?? null}
        isBusy={busy}
        onKeepLocal={(resumeId) => resolve(resumeId, "keep-local")}
        onUseCloud={(resumeId) => resolve(resumeId, "use-cloud")}
      />
    </>
  );
};
