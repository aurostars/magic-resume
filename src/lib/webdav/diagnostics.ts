import type { WebDavSafeError } from "../../store/useWebDavStore";

export type WebDavDiagnosticMessageKey =
  | "newerSnapshotError"
  | "corruptSnapshotError"
  | "jianguoyunAuthError"
  | "authError"
  | "forbiddenError"
  | "networkError"
  | "timeoutError"
  | "directoryError"
  | "quotaError"
  | "proxyProtocolError"
  | "clientNotReadyError"
  | "unknownError";

export interface WebDavDiagnostic {
  messageKey: WebDavDiagnosticMessageKey;
  diagnosticCode: string;
  httpStatus: number | null;
}

const safeHttpStatus = (status: number | null): number | null =>
  Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : null;

const withStatus = (prefix: string, status: number | null): string =>
  status === null ? prefix : `${prefix}-${status}`;

export function getWebDavDiagnostic(
  error: WebDavSafeError,
  jianguoyun: boolean,
): WebDavDiagnostic {
  const httpStatus = safeHttpStatus(error.status);

  if (error.code === "UNKNOWN" && httpStatus === 400 && jianguoyun) {
    return { messageKey: "proxyProtocolError", diagnosticCode: "WD-PROXY-400", httpStatus };
  }

  switch (error.code) {
    case "SNAPSHOT_VERSION":
      return { messageKey: "newerSnapshotError", diagnosticCode: "WD-SNAPSHOT-VERSION", httpStatus };
    case "SNAPSHOT_JSON":
    case "SNAPSHOT_SHAPE":
    case "SNAPSHOT_RESUME":
    case "SNAPSHOT_HASH":
      return { messageKey: "corruptSnapshotError", diagnosticCode: "WD-SNAPSHOT-CORRUPT", httpStatus };
    case "AUTH":
      return {
        messageKey: jianguoyun ? "jianguoyunAuthError" : "authError",
        diagnosticCode: withStatus("WD-AUTH", httpStatus),
        httpStatus,
      };
    case "FORBIDDEN":
      return { messageKey: "forbiddenError", diagnosticCode: withStatus("WD-FORBIDDEN", httpStatus), httpStatus };
    case "NETWORK":
      return { messageKey: "networkError", diagnosticCode: withStatus("WD-NETWORK", httpStatus), httpStatus };
    case "TIMEOUT":
      return { messageKey: "timeoutError", diagnosticCode: withStatus("WD-TIMEOUT", httpStatus), httpStatus };
    case "DIRECTORY":
    case "NOT_FOUND":
      return { messageKey: "directoryError", diagnosticCode: withStatus("WD-DIRECTORY", httpStatus), httpStatus };
    case "QUOTA":
      return { messageKey: "quotaError", diagnosticCode: withStatus("WD-QUOTA", httpStatus), httpStatus };
    case "SERVER":
      return {
        messageKey: "networkError",
        diagnosticCode: httpStatus === 502 ? "WD-UPSTREAM-502" : withStatus("WD-SERVER", httpStatus),
        httpStatus,
      };
    case "CLIENT_NOT_READY":
      return { messageKey: "clientNotReadyError", diagnosticCode: "WD-CLIENT-NOT-READY", httpStatus: null };
    default:
      return {
        messageKey: "unknownError",
        diagnosticCode: httpStatus === null ? "WD-CLIENT-UNKNOWN" : `WD-CLIENT-${httpStatus}`,
        httpStatus,
      };
  }
}
