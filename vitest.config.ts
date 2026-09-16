import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: that file's config is tailored
// for `tauri dev`/`tauri build` (fixed port, src-tauri watch-ignore) and
// none of that applies to running unit tests under Node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
