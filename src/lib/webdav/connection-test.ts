import {
  WEB_DAV_REQUEST_TIMEOUT_MS,
  WebDavClient,
  type WebDavClientConfig,
} from "./client";

export interface WebDavConnectionTestSettings
  extends Omit<WebDavClientConfig, "timeoutMs"> {
  remoteDirectory: string;
}

export async function testWebDavConnection(
  settings: WebDavConnectionTestSettings,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const client = new WebDavClient({
    ...settings,
    timeoutMs: WEB_DAV_REQUEST_TIMEOUT_MS,
  }, fetchImpl);
  await client.options(settings.remoteDirectory, signal);
  await client.propfind(settings.remoteDirectory, signal);
}
