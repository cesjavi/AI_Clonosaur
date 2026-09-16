import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // vercel-backend is a separate Next.js project with its own package.json,
  // tsconfig, and lint setup — not part of this app's build/test pipeline.
  { ignores: ["dist", "src-tauri", "node_modules", "vercel-backend"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Import-file-only helpers exported for unit testing (parseWhatsappTimestamp,
      // fingerprintFileName, etc.) are the norm in src/backend — unused-var
      // warnings on those would fight the pattern rather than catch real bugs.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
