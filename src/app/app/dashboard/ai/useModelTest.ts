import { useEffect, useRef, useState } from "react";
import { toAIConnection, type AIModelProfile } from "@/config/ai-models";
import { combineAbortSignals } from "@/lib/abort-signal";
import { requestPdfImport } from "@/lib/pdf-import-client";
import { ResumeImportError } from "@/lib/resume-import-schema";
import { getApiRequestUrl } from "@/config/runtime-endpoints";

export type ModelTestState =
  | { status: "idle" }
  | { status: "running"; kind: "text" | "pdf" }
  | { status: "success"; kind: "text" | "pdf" }
  | { status: "error"; error: unknown };

export async function requestTextModelTest(
  connection: ReturnType<typeof toAIConnection>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(getApiRequestUrl("/api/ai-test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connection }),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new ResumeImportError(data?.code || "upstreamError");
  }
}

export function useModelTest(profile: AIModelProfile) {
  const [state, setState] = useState<ModelTestState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const { provider, protocol, apiKey, model, baseUrl } = profile;
  useEffect(() => {
    revision.current += 1;
    controller.current?.abort();
    setState({ status: "idle" });
    return () => {
      revision.current += 1;
      controller.current?.abort();
    };
  }, [provider, protocol, apiKey, model, baseUrl]);

  const run = async (kind: "text" | "pdf") => {
    const currentRevision = ++revision.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState({ status: "running", kind });
    try {
      const connection = toAIConnection(profile);
      if (kind === "pdf") {
        const digits = String(
          100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000),
        );
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 120;
        const context = canvas.getContext("2d");
        if (!context) throw new ResumeImportError("visionTestFailed");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, 400, 120);
        context.fillStyle = "#111";
        context.font = "bold 56px sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(digits, 200, 60);
        const data = await requestPdfImport(
          connection,
          [canvas.toDataURL("image/png")],
          true,
          abort.signal,
        );
        if (data.code !== digits)
          throw new ResumeImportError("visionTestFailed");
      } else {
        await requestTextModelTest(
          connection,
          combineAbortSignals([
            abort.signal,
            AbortSignal.timeout(130_000),
          ]),
        );
      }
      if (revision.current === currentRevision)
        setState({ status: "success", kind });
    } catch (error) {
      if (revision.current === currentRevision)
        setState({
          status: "error",
          error:
            error instanceof ResumeImportError
              ? error
              : new ResumeImportError(
                  error instanceof Error && error.name === "TimeoutError"
                    ? "timeout"
                    : "networkError",
                ),
        });
    }
  };
  return { state, run };
}
