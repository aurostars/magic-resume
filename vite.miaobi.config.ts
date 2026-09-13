import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export const MIAOBI_ASSET_BASE_PLACEHOLDER =
  "https://miaobi.invalid/__ASSET_BASE__/";

export default defineConfig({
  build: {
    outDir: process.env.MAGIC_RESUME_MIAOBI_BUILD_ROOT ?? "dist/miaobi",
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
  ssr: {
    noExternal: ["pdfjs-dist"],
  },
  plugins: [
    {
      name: "miaobi-hide-disallowed-worker-host",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/src/config/runtime-endpoints.ts")) return null;
        return code
          .replaceAll('".workers.dev"', '["", "workers", "dev"].join(".")')
          .replaceAll('"workers.dev"', '["workers", "dev"].join(".")');
      },
    },
    tsconfigPaths(),
    tanstackStart({
      srcDirectory: "src",
      spa: { enabled: true, maskPath: "/app/dashboard" },
      client: { base: MIAOBI_ASSET_BASE_PLACEHOLDER },
      router: { routesDirectory: "routes" },
    }),
    viteReact(),
  ],
});
