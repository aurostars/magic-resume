export interface MiaobiRuntimeInjection {
  platform: "miaobi";
  apiFunctionUrl: string;
  assetBaseUrl: string;
}

function escapeInlineJson(value: string): string {
  return value.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return character;
    }
  });
}

export function injectMiaobiRuntime(
  html: string,
  config: MiaobiRuntimeInjection,
): string {
  const firstApplicationScript = html.search(/<script\b/i);
  if (firstApplicationScript < 0) {
    throw new Error("Miaobi SPA shell has no application script");
  }

  const assignment = `<script>window.__MAGIC_RESUME_RUNTIME__=${escapeInlineJson(JSON.stringify(config))}</script>`;
  return `${html.slice(0, firstApplicationScript)}${assignment}${html.slice(firstApplicationScript)}`;
}
