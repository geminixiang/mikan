export type {
  WebFallbackHandler,
  WebRoute,
  WebRouteKind,
  WebServerListenOptions,
  WebUpgradeRoute,
} from "./webserver.js";
export { WebServer } from "./webserver.js";
export { registerStaticFallback, serveStatic, type StaticFallbackOptions } from "./static.js";
