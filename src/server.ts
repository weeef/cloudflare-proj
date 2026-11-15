/**
 * Worker entry point.
 *
 * A Cloudflare Worker is the HTTP front door. Static files (the React UI in
 * /public after `vite build`) are served by Workers Static Assets before this
 * code even runs; only paths listed in wrangler.jsonc `run_worker_first`
 * (e.g. /agents/*) reach this fetch handler.
 *
 * routeAgentRequest() maps URLs like /agents/rack-ops-agent/<name> to the
 * matching Durable Object instance and upgrades the request to a WebSocket.
 */
import { routeAgentRequest } from "agents";

// Durable Object classes must be exported from the entry module so the
// runtime can find them by the class_name in wrangler.jsonc.
export { RackOpsAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
