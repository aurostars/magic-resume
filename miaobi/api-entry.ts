import { createMiaobiFaasAdapter } from "../scripts/miaobi/faas-adapter";
import { handleApiRequest } from "../src/lib/server/api-router";

declare const __MIAOBI_API_BUILD_MARKER__: string;
const API_BUILD_MARKER = typeof __MIAOBI_API_BUILD_MARKER__ === "string"
  ? __MIAOBI_API_BUILD_MARKER__
  : "development";

export interface MiaobiFaasRequest extends Request {}

const routeMiaobiApi = createMiaobiFaasAdapter(handleApiRequest);

export async function handleMiaobiApi(request: Request): Promise<Response> {
  const response = await routeMiaobiApi(request);
  const headers = new Headers(response.headers);
  headers.set("X-Magic-Resume-Faas", "magic-resume-api");
  headers.set("X-Magic-Resume-Build", API_BUILD_MARKER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
