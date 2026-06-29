// ESLint flat config (ADR-0016 toolchain). Deliberately lean: we gate on
// type-aware CORRECTNESS rules — floating/misused promises were the class of
// bug the SDLC review flagged — not on stylistic preferences (Prettier owns
// formatting). Warnings are informational; only errors fail CI.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "out/**",
      "media/**",
      "node_modules/**",
      "**/*.vsix",
      "esbuild.js",
      "eslint.config.mjs",
      "scripts/**",
      "test/**",
    ],
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The correctness rules we actually care about (type-aware):
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "no-throw-literal": "off",
      "@typescript-eslint/only-throw-error": "off",
      // Pragmatic dial-downs — this is a mature codebase with deliberate `any`
      // at Graph/JSON boundaries; these would be pure noise, not signal.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      // We deliberately match control chars (NUL etc.) when sanitizing LDAP
      // filters / DNs (RFC 4515) — that is the point, not an accident.
      "no-control-regex": "off",
    },
  },
);
