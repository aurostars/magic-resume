import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import type { WebDavConflict } from "@/store/useWebDavStore";

export interface WebDavConflictDialogProps {
  conflict: WebDavConflict | null;
  isBusy: boolean;
  onUseLocal: () => Promise<void>;
  onUseCloud: () => Promise<void>;
  onDismiss: () => void;
}

const VersionDetails = ({
  title,
  side,
}: {
  title: string;
  side: WebDavConflict["local"];
}) => {
  const t = useTranslations("dashboard.settings.webdav");
  const locale = useLocale();
  return (
    <section className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <h4 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h4>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-gray-500 dark:text-gray-400">{t("updatedAt")}</dt>
        <dd className="break-all text-gray-800 dark:text-gray-200">
          <time dateTime={side.updatedAt}>{new Date(side.updatedAt).toLocaleString(locale)}</time>
        </dd>
        <dt className="text-gray-500 dark:text-gray-400">{t("device")}</dt>
        <dd className="break-all font-mono text-gray-800 dark:text-gray-200">{side.deviceId}</dd>
        <dt className="text-gray-500 dark:text-gray-400">{t("resumeCount")}</dt>
        <dd className="text-gray-800 dark:text-gray-200">{side.resumeCount}</dd>
      </dl>
    </section>
  );
};

export const WebDavConflictDialog = ({
  conflict,
  isBusy,
  onUseLocal,
  onUseCloud,
  onDismiss,
}: WebDavConflictDialogProps) => {
  const t = useTranslations("dashboard.settings.webdav");
  const dismissRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (conflict) returnFocusRef.current = document.activeElement as HTMLElement | null;
  }, [conflict]);

  return (
    <Dialog
      open={conflict !== null}
      onOpenChange={(open) => {
        if (!open && !isBusy) onDismiss();
      }}
    >
      <DialogContent
        aria-modal="true"
        className="max-w-2xl"
        hideClose
        onEscapeKeyDown={(event) => {
          if (isBusy) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dismissRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("conflictTitle")}</DialogTitle>
          <DialogDescription>{t("conflictBody")}</DialogDescription>
        </DialogHeader>
        {conflict && (
          <div className="mt-1 grid gap-4 md:grid-cols-2">
            <VersionDetails title={t("localVersion")} side={conflict.local} />
            <VersionDetails title={t("cloudVersion")} side={conflict.cloud} />
          </div>
        )}
        <DialogFooter className="mt-2 gap-3 sm:space-x-0">
          <Button ref={dismissRef} type="button" variant="ghost" disabled={isBusy} onClick={onDismiss}>
            {t("dismiss")}
          </Button>
          <Button type="button" variant="outline" disabled={isBusy} onClick={onUseLocal}>
            {t("useLocal")}
          </Button>
          <Button type="button" disabled={isBusy} onClick={onUseCloud}>
            {t("useCloud")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
