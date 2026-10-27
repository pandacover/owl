import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // End-to-end tests start real servers and run FFmpeg.
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
})
