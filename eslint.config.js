import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `any` is permitted only in the adapters layer (raw Redis/proto edges);
      // everywhere else it's an error. Enforced via the override below.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Adapters touch untyped Redis replies and proto-loader output; allow `any`
    // there but nowhere else.
    files: ["src/adapters/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  prettier,
);
