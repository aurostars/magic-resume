import { createFileRoute } from "@tanstack/react-router";
import { handleImageProxy } from "@/lib/server/image-proxy";

export const Route = createFileRoute("/api/proxy/image")({
  server: {
    handlers: {
      GET: ({ request }) => handleImageProxy(request),
    },
  },
});
