import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/**", "**/node_modules/**"]
  },
  {
    rules: {
      // Allow the conventional leading-underscore marker for intentionally
      // unused bindings (e.g. interface-required handler params like `_req`).
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    }
  }
);
