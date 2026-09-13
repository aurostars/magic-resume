import { createHashHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter(options: { platform?: "default" | "miaobi" } = {}) {
  return createRouter({
    routeTree,
    history: options.platform === "miaobi" ? createHashHistory() : undefined,
    scrollRestoration: true
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
