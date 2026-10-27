// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.dev/**",
      "**/node_modules/**",
      "test-results/**",
      "playwright-report/**",
      // Runtime data of end-to-end runs (git-ignored), including files the tests create.
      "tests/e2e/.state*/**",
      "graphify-out/**",
      // App templates are projects of their own (checked by building and testing generated apps).
      "packages/create-everyos-app/templates/**",
      "**/.everyos/**",
      "services/**/worker-configuration.d.ts",
      "services/**/.wrangler/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },
  {
    files: [
      "apps/api/**",
      "apps/agent/**",
      "packages/**",
      "services/**",
      "scripts/**",
      "tests/**",
      "*.config.*",
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // EveryOS is often opened over plain HTTP by a host address, where it does not exist.
      "no-restricted-properties": [
        "error",
        {
          object: "crypto",
          property: "randomUUID",
          message: "Use randomId() from lib/random-id.ts; plain HTTP pages have no randomUUID.",
        },
      ],
    },
  },
  {
    files: ["apps/web/src/lib/random-id.ts"],
    rules: { "no-restricted-properties": "off" },
  },
  {
    // Scripts and tests are allowed to print to the console.
    files: ["scripts/**", "tests/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
