import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    globalSetup: ["src/__tests__/globalSetup.ts"],
    // The engine and registries are module-level singletons; parallel files
    // would fight over them.
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/services/**", "src/utils/**", "src/config/countries.ts"],
      exclude: ["src/services/gender/http.ts"],
    },
  },
});
