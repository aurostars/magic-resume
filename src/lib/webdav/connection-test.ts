import { WebDavClient, type WebDavClientConfig } from "./client";

export interface WebDavConnectionTestSettings extends WebDavClientConfig {
  remoteDirectory: string;
}

export async function testWebDavConnection(
  settings: WebDavConnectionTestSettings,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const client = new WebDavClient(settings, fetchImpl);
  await client.options(settings.remoteDirectory, signal);
  await client.propfind(settings.remoteDirectory, signal);
}
