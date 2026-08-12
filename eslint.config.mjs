import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/**
 * ESLint 9 flat config. The previous `.eslintrc.json` (eslintrc format) is no
 * longer read by ESLint 9, and eslint-config-next 16 ships flat-config arrays
 * rather than eslintrc `extends` strings, so the two changes have to land
 * together.
 *
 * @type {import('eslint').Linter.Config[]}
 */
const config = [
  {
    // Build output, generated Prisma client and dependencies are not source.
    // src/generated/prisma in particular embeds the whole schema as a string
    // literal and linting it produces nothing but noise.
    ignores: [
      ".next/**",
      "node_modules/**",
      "src/generated/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    settings: {
      next: { rootDir: projectRoot },
    },
  },
];

export default config;
