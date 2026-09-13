import { createFileRoute } from "@tanstack/react-router";
import {
  createCloudflareFetchTransport,
  handleImageProxy,
} from "@/lib/server/image-proxy";

const cloudflareTransport = createCloudflareFetchTransport();

export const Route = createFileRoute("/api/proxy/image")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleImageProxy(request, { transport: cloudflareTransport }),
    },
  },
});
