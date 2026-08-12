import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Vitest runs the pure calculation layer only, so no jsdom / React environment is configured.
//
// `include` is deliberately narrow: the project's tsconfig globs `**/*.ts`, and a wide default
// test glob would try to collect Prisma's generated client and the Next.js build output.
//
// The `@/` alias is re-declared here rather than pulled from tsconfig via a plugin, because one
// alias is not worth an extra dependency. Keep it in sync with tsconfig.json `paths`.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
