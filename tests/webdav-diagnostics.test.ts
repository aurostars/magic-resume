import assert from "node:assert/strict";
import test from "node:test";
import { getWebDavDiagnostic } from "../src/lib/webdav/diagnostics";
import type { WebDavSafeError } from "../src/store/useWebDavStore";

test("classifies safe WebDAV errors into stable diagnostics", () => {
  const cases: Array<{
    name: string;
    error: WebDavSafeError;
    jianguoyun: boolean;
    expected: ReturnType<typeof getWebDavDiagnostic>;
  }> = [
    {
      name: "Jianguoyun proxy protocol response",
      error: { code: "UNKNOWN", status: 400 },
      jianguoyun: true,
      expected: { messageKey: "proxyProtocolError", diagnosticCode: "WD-PROXY-400", httpStatus: 400 },
    },
    {
      name: "Jianguoyun authentication",
      error: { code: "AUTH", status: 401 },
      jianguoyun: true,
      expected: { messageKey: "jianguoyunAuthError", diagnosticCode: "WD-AUTH-401", httpStatus: 401 },
    },
    {
      name: "upstream gateway failure",
      error: { code: "SERVER", status: 502 },
      jianguoyun: true,
      expected: { messageKey: "networkError", diagnosticCode: "WD-UPSTREAM-502", httpStatus: 502 },
    },
    {
      name: "client not ready",
      error: { code: "CLIENT_NOT_READY", status: null },
      jianguoyun: true,
      expected: { messageKey: "clientNotReadyError", diagnosticCode: "WD-CLIENT-NOT-READY", httpStatus: null },
    },
    {
      name: "unknown client failure",
      error: { code: "UNKNOWN", status: null },
      jianguoyun: true,
      expected: { messageKey: "unknownError", diagnosticCode: "WD-CLIENT-UNKNOWN", httpStatus: null },
    },
    {
      name: "forbidden response",
      error: { code: "FORBIDDEN", status: 403 },
      jianguoyun: false,
      expected: { messageKey: "forbiddenError", diagnosticCode: "WD-FORBIDDEN-403", httpStatus: 403 },
    },
    {
      name: "missing directory",
      error: { code: "NOT_FOUND", status: 404 },
      jianguoyun: false,
      expected: { messageKey: "directoryError", diagnosticCode: "WD-DIRECTORY-404", httpStatus: 404 },
    },
    {
      name: "directory conflict",
      error: { code: "DIRECTORY", status: 409 },
      jianguoyun: false,
      expected: { messageKey: "directoryError", diagnosticCode: "WD-DIRECTORY-409", httpStatus: 409 },
    },
    {
      name: "quota exceeded",
      error: { code: "QUOTA", status: 507 },
      jianguoyun: false,
      expected: { messageKey: "quotaError", diagnosticCode: "WD-QUOTA-507", httpStatus: 507 },
    },
    {
      name: "timeout",
      error: { code: "TIMEOUT", status: null },
      jianguoyun: false,
      expected: { messageKey: "timeoutError", diagnosticCode: "WD-TIMEOUT", httpStatus: null },
    },
    {
      name: "network failure",
      error: { code: "NETWORK", status: null },
      jianguoyun: false,
      expected: { messageKey: "networkError", diagnosticCode: "WD-NETWORK", httpStatus: null },
    },
    {
      name: "non-Jianguoyun bad request",
      error: { code: "UNKNOWN", status: 400 },
      jianguoyun: false,
      expected: { messageKey: "unknownError", diagnosticCode: "WD-CLIENT-400", httpStatus: 400 },
    },
    {
      name: "newer snapshot version",
      error: { code: "SNAPSHOT_VERSION", status: null },
      jianguoyun: false,
      expected: { messageKey: "newerSnapshotError", diagnosticCode: "WD-SNAPSHOT-VERSION", httpStatus: null },
    },
    {
      name: "corrupt snapshot",
      error: { code: "SNAPSHOT_HASH", status: null },
      jianguoyun: false,
      expected: { messageKey: "corruptSnapshotError", diagnosticCode: "WD-SNAPSHOT-CORRUPT", httpStatus: null },
    },
  ];

  for (const { name, error, jianguoyun, expected } of cases) {
    assert.deepEqual(getWebDavDiagnostic(error, jianguoyun), expected, name);
  }
});

test("rejects invalid runtime HTTP statuses from diagnostics", () => {
  for (const status of [Number.NaN, 99, 600, 401.5]) {
    const error = { code: "AUTH", status } as WebDavSafeError;
    assert.deepEqual(getWebDavDiagnostic(error, false), {
      messageKey: "authError",
      diagnosticCode: "WD-AUTH",
      httpStatus: null,
    });
  }
});
