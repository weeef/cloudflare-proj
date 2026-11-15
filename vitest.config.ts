// Separate config for unit tests. The main vite.config.ts loads the
// Cloudflare plugin (which spins up the Workers runtime and needs a
// Cloudflare login for the remote AI binding). Our tests cover pure logic,
// so they run in plain Node with none of that.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] }
});
