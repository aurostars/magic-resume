import { createMiaobiFaasAdapter } from "../scripts/miaobi/faas-adapter";
import {
  defaultApiRouterDependencies,
  handleApiRequest,
} from "../src/lib/server/api-router";
import { handleImageProxy, type ImageProxyTransport } from "../src/lib/server/image-proxy";
import { handleJianguoyunWebDavProxy } from "../src/lib/server/jianguoyun-webdav-proxy";

declare const __MIAOBI_API_BUILD_MARKER__: string;
const API_BUILD_MARKER = typeof __MIAOBI_API_BUILD_MARKER__ === "string"
  ? __MIAOBI_API_BUILD_MARKER__
  : "development";

export interface MiaobiFaasRequest extends Request {}

export function createMiaobiApiHandler(
  imageTransport?: ImageProxyTransport,
  jianguoyunHandler = handleJianguoyunWebDavProxy,
) {
  return createMiaobiFaasAdapter((request, logicalPath) =>
    handleApiRequest(request, logicalPath, {
      ...defaultApiRouterDependencies,
      imageProxy: (imageRequest) => imageTransport
        ? handleImageProxy(imageRequest, { transport: imageTransport })
        : handleImageProxy(imageRequest),
      webdavJianguoyun: jianguoyunHandler,
    }));
}

const routeMiaobiApi = createMiaobiApiHandler();

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
