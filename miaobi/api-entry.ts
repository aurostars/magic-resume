import { createMiaobiFaasAdapter } from "../scripts/miaobi/faas-adapter";
import { handleApiRequest } from "../src/lib/server/api-router";

export interface MiaobiFaasRequest extends Request {}

const routeMiaobiApi = createMiaobiFaasAdapter(handleApiRequest);

export async function handleMiaobiApi(request: Request): Promise<Response> {
  const response = await routeMiaobiApi(request);
  const headers = new Headers(response.headers);
  headers.set("X-Magic-Resume-Faas", "magic-resume-api");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
