import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    // PGlite + model streaming can take a moment on a cold start.
    testTimeout: 30_000,
    // The file-backed PGlite database is a single shared resource; running test
    // files in parallel workers opens the same directory concurrently and
    // crashes the WASM engine. Run files sequentially (matches the app's
    // single-process model). Tests within a file still run together.
    fileParallelism: false,
  },
});
