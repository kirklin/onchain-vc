import kirklin from "@kirklin/eslint-config";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default kirklin(
  {
    react: true,
    typescript: true,
    formatters: true,
    nextjs: true,
    ignores: [
      // Written by `wagmi generate` and by Foundry.
      "web/src/contracts/**",
      "contracts/deployments/**",
      "contracts/out/**",
      "contracts/cache/**",
      "contracts/broadcast/**",
    ],
  },
  jsxA11y.flatConfigs.recommended,
  {
    rules: {
      "node/prefer-global/process": "off",
      // Only meaningful with a pages/ directory. This app uses the App Router alone.
      "next/no-html-link-for-pages": "off",
    },
  },
  {
    // Next.js reads metadata and route options from named exports beside the component.
    files: ["web/src/app/**"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // Patterns in assertions run once per test.
    files: ["web/tests/**", "e2e/**"],
    rules: { "e18e/prefer-static-regex": "off" },
  },
  {
    // Command-line scripts report what they did on stdout.
    files: ["scripts/**"],
    rules: { "no-console": "off" },
  },
);
