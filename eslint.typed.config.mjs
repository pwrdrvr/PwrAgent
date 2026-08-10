// Type-aware lint rules run uncached because their results can depend on
// imported declarations. ESLint's per-file cache does not track that type
// dependency graph, so caching this pass could hide errors in unchanged
// consumers when an imported type changes.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/dist/**",
      "**/.vite/**",
      "**/coverage/**",
      "apps/desktop/.local/**",
      "**/protocol-captures/**",
      "**/e2e/fixtures/**",
      "**/__fixtures__/**",
    ],
  },
  {
    files: [
      "apps/*/src/**/*.{ts,tsx}",
      "packages/**/*.{ts,tsx}",
    ],
    ignores: [
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // Production services and adapters are predominantly stateful classes.
      // Extracting one of their methods and calling it as a plain function
      // silently drops its receiver, which TypeScript accepts but crashes when
      // the method reaches `this`. Keep this typed rule out of test code;
      // test mock assertions intentionally reference methods without calling
      // them and would bury actionable findings in false positives.
      "@typescript-eslint/unbound-method": "error",
    },
  },
);
