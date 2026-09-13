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
import type { ResumeSyncConflict } from "@/lib/webdav/types";

export interface WebDavConflictDialogProps {
  conflict: ResumeSyncConflict | null;
  isBusy: boolean;
  onKeepLocal: (resumeId: string) => Promise<void>;
  onUseCloud: (resumeId: string) => Promise<void>;
}

const ConflictTime = ({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) => {
  const locale = useLocale();
  const t = useTranslations("dashboard.settings.webdav");
  return (
    <div>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 text-gray-800 dark:text-gray-200">
        {value
          ? <time dateTime={value}>{new Date(value).toLocaleString(locale)}</time>
          : t("notAvailable")}
      </dd>
    </div>
  );
};

export const WebDavConflictDialog = ({
  conflict,
  isBusy,
  onKeepLocal,
  onUseCloud,
}: WebDavConflictDialogProps) => {
  const t = useTranslations("dashboard.settings.webdav");

  return (
    <Dialog open={conflict !== null}>
      <DialogContent
        aria-modal="true"
        className="max-w-lg"
        hideClose
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("conflictTitle")}</DialogTitle>
          <DialogDescription>{t("conflictBody")}</DialogDescription>
        </DialogHeader>
        {conflict && (
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
              <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                {conflict.title}
              </h4>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t(conflict.kind === "both-modified" ? "bothModified" : "deleteVsModify")}
              </p>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <ConflictTime label={t("localUpdatedAt")} value={conflict.localUpdatedAt} />
                <ConflictTime label={t("remoteUpdatedAt")} value={conflict.remoteUpdatedAt} />
              </dl>
            </div>
            <DialogFooter className="gap-3 sm:space-x-0">
              <Button
                type="button"
                variant="outline"
                disabled={isBusy}
                onClick={() => onKeepLocal(conflict.resumeId)}
              >
                {t("keepLocal")}
              </Button>
              <Button
                type="button"
                disabled={isBusy}
                onClick={() => onUseCloud(conflict.resumeId)}
              >
                {t("useCloud")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
