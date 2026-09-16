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
    const frame = window.requestAnimationFrame(() => {
      clearPendingIdRef.current();
      navigateRef.current(resumeId);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isDialogOpen, pendingId]);
}
