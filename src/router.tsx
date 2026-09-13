import { createRouter } from "@tanstack/react-router";
import { createAppHistory, getRuntimeConfig } from "./config/runtime-endpoints";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const runtimeConfig = getRuntimeConfig();
  return createRouter({
    routeTree,
    history: runtimeConfig.platform === "miaobi" ? createAppHistory() : undefined,
    scrollRestoration: true
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
