import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createWebFaasHandler } from "../../miaobi/web-entry";
import { validateMiaobiRuntimeInjection, type MiaobiRuntimeInjection } from "../../miaobi/runtime-config";

const webEntryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../miaobi/web-entry.ts");

export async function buildWebFaas(html: string, outputDirectory: string): Promise<string> {
  const runtime = /window\.__MAGIC_RESUME_RUNTIME__=(\{[^<]+\})<\/script>/.exec(html);
  if (!runtime) throw new Error("MIAOBI_INVALID_WEB_HTML");
  let config: MiaobiRuntimeInjection;
  try {
    config = JSON.parse(runtime[1]) as MiaobiRuntimeInjection;
  } catch {
    throw new Error("MIAOBI_INVALID_WEB_HTML");
  }
  validateMiaobiRuntimeInjection(config);
  createWebFaasHandler(html);
  await mkdir(outputDirectory, { recursive: true });
  const webBundlePath = join(outputDirectory, "web-faas.cjs");
  await build({
    stdin: {
      contents: `import { createWebFaasHandler } from ${JSON.stringify(webEntryPath)};\nexport const handler = createWebFaasHandler(${JSON.stringify(html)});`,
      loader: "ts",
      resolveDir: resolve("."),
    },
    outfile: webBundlePath,
    bundle: true,
    platform: "node",
    format: "iife",
    target: "node20",
    globalName: "MagicResumeWeb",
    footer: { js: "module.exports = MagicResumeWeb.handler" },
  });
  return webBundlePath;
}
