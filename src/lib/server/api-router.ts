import { handleTextRequest } from "./ai-text";
import { handleResumeImport } from "./resume-import";

export type ApiRoutePath =
  | "/api/grammar"
  | "/api/polish"
  | "/api/ai-test"
  | "/api/resume-import"
  | "/api/proxy/image"
  | "/api/webdav/jianguoyun";

export interface ApiRouterDependencies {
  grammar: (request: Request) => Promise<Response>;
  polish: (request: Request) => Promise<Response>;
  aiTest: (request: Request) => Promise<Response>;
  resumeImport: (request: Request) => Promise<Response>;
  imageProxy: (request: Request) => Promise<Response>;
  webdavJianguoyun: (request: Request) => Promise<Response>;
}

export const defaultApiRouterDependencies: ApiRouterDependencies = {
  grammar: (request) => handleTextRequest(request, "grammar"),
  polish: (request) => handleTextRequest(request, "polish"),
  aiTest: (request) => handleTextRequest(request, "test"),
  resumeImport: (request) => handleResumeImport(request),
  imageProxy: async (request) => {
    const { handleImageProxy } = await import("./image-proxy");
    return handleImageProxy(request);
  },
  webdavJianguoyun: async (request) => {
    const { handleJianguoyunWebDavProxy } = await import("./jianguoyun-webdav-proxy");
    return handleJianguoyunWebDavProxy(request);
  },
};

const routes: Record<
  ApiRoutePath,
  { method: "GET" | "POST"; dependency: keyof ApiRouterDependencies }
> = {
  "/api/grammar": { method: "POST", dependency: "grammar" },
  "/api/polish": { method: "POST", dependency: "polish" },
  "/api/ai-test": { method: "POST", dependency: "aiTest" },
  "/api/resume-import": { method: "POST", dependency: "resumeImport" },
  "/api/proxy/image": { method: "GET", dependency: "imageProxy" },
  "/api/webdav/jianguoyun": { method: "POST", dependency: "webdavJianguoyun" },
};

function jsonError(status: number, error: string, code: string, headers?: HeadersInit) {
  return Response.json({ error, code }, { status, headers });
}

export async function handleApiRequest(
  request: Request,
  logicalPath?: string,
  dependencies: ApiRouterDependencies = defaultApiRouterDependencies,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  let logicalUrl: URL;
  try {
    logicalUrl = logicalPath ? new URL(logicalPath, requestUrl.origin) : requestUrl;
  } catch {
    return jsonError(400, "Invalid API path", "invalidPath");
  }
  const route = routes[logicalUrl.pathname as ApiRoutePath];
  if (!route) return jsonError(404, "Not found", "notFound");
  if (request.method !== route.method) {
    return jsonError(405, "Method not allowed", "methodNotAllowed", {
      Allow: route.method,
    });
  }

  try {
    const routedRequest = logicalPath
      ? new Request(new URL(logicalUrl.pathname + logicalUrl.search, requestUrl.origin), request)
      : request;
    return await dependencies[route.dependency](routedRequest);
  } catch {
    return jsonError(500, "Internal server error", "internalError");
  }
}
