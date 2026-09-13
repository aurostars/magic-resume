export type MiaobiApiRouter = (
  request: Request,
  logicalPath?: string,
) => Promise<Response>;

function invalidPathResponse() {
  return Response.json(
    { error: "Invalid API path", code: "invalidPath" },
    { status: 400 },
  );
}

function logicalRequest(request: Request): {
  request: Request;
  logicalPath: string;
} | undefined {
  try {
    const faasUrl = new URL(request.url);
    const paths = faasUrl.searchParams.getAll("__path");
    if (paths.length !== 1) return undefined;

    const rawPath = paths[0];
    if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("#")) {
      return undefined;
    }

    const logicalUrl = new URL(rawPath, faasUrl.origin);
    if (
      logicalUrl.origin !== faasUrl.origin ||
      logicalUrl.hash ||
      logicalUrl.searchParams.has("__path")
    ) {
      return undefined;
    }

    for (const [name, value] of faasUrl.searchParams) {
      if (name !== "__path") logicalUrl.searchParams.append(name, value);
    }

    const logicalPath = `${logicalUrl.pathname}${logicalUrl.search}`;
    return {
      request: new Request(logicalUrl, request),
      logicalPath,
    };
  } catch {
    return undefined;
  }
}

export function createMiaobiFaasAdapter(router: MiaobiApiRouter) {
  return async (request: Request): Promise<Response> => {
    const logical = logicalRequest(request);
    if (!logical) return invalidPathResponse();
    return router(logical.request, logical.logicalPath);
  };
}
