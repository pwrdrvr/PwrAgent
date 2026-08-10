// Flat ESLint config — correctness only, no stylistic rules.
//
// This repo has no autoformatter and hand-maintains its code style (see
// AGENTS.md). ESLint here catches real bugs (unsafe control flow, unused
// symbols, hook misuse); it does NOT enforce formatting. Do not add
// stylistic/whitespace rules — those belong to a formatter, which this repo
// deliberately does not run.
//
// Adoption posture: the codebase predates ESLint, so a handful of pre-existing
// patterns (untyped `any`, unused symbols, intentional control-char regexes in
// validation code, deliberate whitespace test fixtures) are set to "warn"
// rather than "error". They are a baseline to burn down over time — CI blocks
// on errors, surfaces warnings. Tighten a rule to "error" once its warning
// count reaches zero.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

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
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Classic React hooks safety only. The plugin's flat "recommended-latest"
    // also enables the React-Compiler-era rules (purity, immutability,
    // set-state-in-render, …); those are out of scope for an adoption baseline.
    // rules-of-hooks catches real crashes; exhaustive-deps is the rule the
    // existing inline `// eslint-disable-next-line` directives already target.
    //
    // Scoped to the renderer — React lives only under src/renderer. Applying
    // rules-of-hooks (error) repo-wide would false-positive on any
    // `use`-prefixed non-hook function in main-process/Node code and fail CI
    // with no fix but an inline disable.
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
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
);
