// Flat ESLint config — correctness only, no stylistic rules.
//
// Prettier owns all formatting; eslint-config-prettier (last in the array)
// turns off any ESLint rule that would fight it. This config exists to catch
// real bugs, not to enforce code style. Do not add stylistic/formatting rules.
//
// Adoption posture: the codebase predates ESLint, so a handful of pre-existing
// patterns (untyped `any`, unused symbols, intentional control-char regexes in
// validation code) are set to "warn" rather than "error". They are a baseline
// to burn down over time — CI blocks on errors, surfaces warnings. Tighten a
// rule to "error" once its warning count reaches zero.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // Keep in sync with .prettierignore.
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
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Classic React hooks safety only. The plugin's flat "recommended-latest"
    // also enables the React-Compiler-era rules (purity, immutability,
    // set-state-in-render, …); those are out of scope for an adoption baseline.
    // rules-of-hooks catches real crashes; exhaustive-deps is the rule the
    // existing inline `// eslint-disable-next-line` directives already target.
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Underscore-prefixed args/vars are an intentional "unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Pre-existing baseline (see header). Warn, don't block. Several of
      // these are not auto-fixable and hand-fixing risks changing behavior:
      // no-irregular-whitespace flags deliberate whitespace fixtures in the
      // messaging tests, and no-useless-escape flags defensive escapes in the
      // TOML-editor regexes. Keep them visible without blocking CI.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "prefer-const": "warn",
      "no-useless-escape": "warn",
      "no-irregular-whitespace": "warn",
      "no-case-declarations": "warn",
      // Control-character classes are deliberate in messaging id/label
      // validation (packages/shared) — those files reject C0/C1 ranges on
      // purpose. Warn so new uses are visible without blocking the guards.
      "no-control-regex": "warn",
    },
  },
  eslintConfigPrettier,
);
