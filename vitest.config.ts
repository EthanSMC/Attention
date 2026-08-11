import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "@attention/ai": `${root}packages/ai/src/index.ts`,
      "@attention/auth": `${root}packages/auth/src/index.ts`,
      "@attention/collector": `${root}packages/collector/src/index.ts`,
      "@attention/contracts": `${root}packages/contracts/src/index.ts`,
      "@attention/db/migrate": `${root}packages/db/src/migrate.ts`,
      "@attention/db": `${root}packages/db/src/index.ts`,
      "@attention/domain": `${root}packages/domain/src/index.ts`,
      "@attention/testkit": `${root}packages/testkit/src/index.ts`,
      "server-only": `${root}tests/mocks/server-only.ts`
    }
  },
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
    ],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
