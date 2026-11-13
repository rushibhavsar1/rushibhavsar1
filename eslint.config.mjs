import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "coverage/**"]),
  {
    // CLAUDE.md: all Anthropic calls go through ONE module (src/lib/ai.ts).
    files: ["**/*.{ts,tsx,js,mjs}"],
    ignores: ["src/lib/ai.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@anthropic-ai/sdk", "@anthropic-ai/sdk/*"],
              message: "Only src/lib/ai.ts may import the Anthropic SDK.",
            },
          ],
        },
      ],
    },
  },
  {
    // Secrets only on the server: client components must not import server modules.
    files: ["src/components/client/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/server/*", "@/lib/db", "@/lib/env"], message: "Server-only module." }] },
      ],
    },
  },
]);
