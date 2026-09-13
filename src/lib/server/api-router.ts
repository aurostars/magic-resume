import { handleTextRequest } from "./ai-text";
import { handleResumeImport } from "./resume-import";

export type ApiRoutePath =
  | "/api/grammar"
  | "/api/polish"
  | "/api/resume-import"
  | "/api/proxy/image";

export interface ApiRouterDependencies {
  grammar: (request: Request) => Promise<Response>;
  polish: (request: Request) => Promise<Response>;
  resumeImport: (request: Request) => Promise<Response>;
  imageProxy: (request: Request) => Promise<Response>;
}

const defaultDependencies: ApiRouterDependencies = {
  grammar: (request) => handleTextRequest(request, "grammar"),
  polish: (request) => handleTextRequest(request, "polish"),
  resumeImport: (request) => handleResumeImport(request),
  imageProxy: async (request) => {
    const { handleImageProxy } = await import("./image-proxy");
    return handleImageProxy(request);
  },
};

const routes: Record<
  ApiRoutePath,
  { method: "GET" | "POST"; dependency: keyof ApiRouterDependencies }
> = {
  "/api/grammar": { method: "POST", dependency: "grammar" },
  "/api/polish": { method: "POST", dependency: "polish" },
  "/api/resume-import": { method: "POST", dependency: "resumeImport" },
  "/api/proxy/image": { method: "GET", dependency: "imageProxy" },
};

function jsonError(status: number, error: string, code: string, headers?: HeadersInit) {
  return Response.json({ error, code }, { status, headers });
}

export async function handleApiRequest(
  request: Request,
  logicalPath?: string,
  dependencies: ApiRouterDependencies = defaultDependencies,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const logicalUrl = logicalPath ? new URL(logicalPath, requestUrl.origin) : requestUrl;
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
