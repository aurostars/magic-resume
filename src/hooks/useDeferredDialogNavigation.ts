import { useEffect, useRef } from "react";

export interface DeferredDialogNavigationOptions {
  isDialogOpen: boolean;
  pendingId: string | null;
  clearPendingId: () => void;
  navigate: (id: string) => void;
}

export function useDeferredDialogNavigation({
  isDialogOpen,
  pendingId,
  clearPendingId,
  navigate,
}: DeferredDialogNavigationOptions): void {
  const clearPendingIdRef = useRef(clearPendingId);
  const navigateRef = useRef(navigate);
  clearPendingIdRef.current = clearPendingId;
  navigateRef.current = navigate;

  useEffect(() => {
    if (isDialogOpen || !pendingId) return;

    const resumeId = pendingId;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      cancelled = true;
      clearPendingIdRef.current();
      navigateRef.current(resumeId);
    };

    if (typeof MessageChannel === "undefined") {
      queueMicrotask(run);
      return () => {
        cancelled = true;
      };
    }

    const channel = new MessageChannel();
    channel.port1.onmessage = run;
    channel.port2.postMessage(undefined);

    return () => {
      cancelled = true;
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    };
  }, [isDialogOpen, pendingId]);
}
