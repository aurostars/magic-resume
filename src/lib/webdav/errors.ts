export type WebDavErrorCode =
  | "HTTPS_REQUIRED"
  | "AUTH"
  | "FORBIDDEN"
  | "NETWORK"
  | "TIMEOUT"
  | "ABORTED"
  | "NOT_FOUND"
  | "DIRECTORY"
  | "QUOTA"
  | "MOVE_UNSUPPORTED"
  | "REMOTE_CAS_MISMATCH"
  | "REMOTE_CONTENT_MISMATCH"
  | "INVALID_REMOTE_RESUME"
  | "SERVER"
  | "UNKNOWN";

export class WebDavError extends Error {
  constructor(
    public readonly code: WebDavErrorCode,
    public readonly status: number | null = null,
  ) {
    super(code);
    this.name = "WebDavError";
  }
}

export class LocalCasMismatchError extends Error {
  readonly code = "LOCAL_CAS_MISMATCH";

  constructor() {
    super("LOCAL_CAS_MISMATCH");
    this.name = "LocalCasMismatchError";
  }
}
