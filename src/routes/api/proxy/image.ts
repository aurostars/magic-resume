import { createFileRoute } from "@tanstack/react-router";
import {
  createCloudflareFetchTransport,
  handleImageProxy,
} from "@/lib/server/image-proxy";

const cloudflareTransport = createCloudflareFetchTransport();

function isVerifiedCloudflareRuntime() {
  return globalThis.navigator?.userAgent === "Cloudflare-Workers";
}

export const Route = createFileRoute("/api/proxy/image")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleImageProxy(
          request,
          isVerifiedCloudflareRuntime() ? { transport: cloudflareTransport } : undefined,
        ),
    },
  },
});
