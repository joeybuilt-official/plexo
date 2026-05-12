import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      // Ban shadcn-style Tailwind tokens that don't resolve in our @theme.
      // Canonical vocab lives in src/app/globals.css — use
      // text-text-primary, bg-surface-1, border-border, text-text-muted, etc.
      //
      // UI-audit Phase 4 (2026-04-11) extended this rule after a codemod
      // swept 276 `text-foreground` + 1 `bg-background` occurrences back to
      // the canonical system. The rule now also catches `text-muted` +
      // `text-muted/<opacity>` (which do not resolve; use `text-text-muted`)
      // and `bg-background` (use `bg-canvas`). `bg-surface` continues to
      // match only when it's the bare token — `bg-surface-1/2/3` is allowed
      // because they are the canonical surface hierarchy.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/\\b(text-foreground|text-muted-foreground|bg-foreground|bg-background|bg-surface(?![-\\w/])|(?<![\\w-])text-muted(?![-\\w])|border-input|ring-input)\\b/]",
          message:
            "Non-resolving design token. Use canonical tokens from globals.css: text-text-primary, text-text-muted, bg-surface-1, border-border, bg-canvas, etc. See the header comment in apps/web/src/app/globals.css.",
        },
        {
          selector: "TemplateElement[value.raw=/\\b(text-foreground|text-muted-foreground|bg-foreground|bg-background|bg-surface(?![-\\w/])|(?<![\\w-])text-muted(?![-\\w])|border-input|ring-input)\\b/]",
          message:
            "Non-resolving design token. Use canonical tokens from globals.css: text-text-primary, text-text-muted, bg-surface-1, border-border, bg-canvas, etc. See the header comment in apps/web/src/app/globals.css.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next.bak/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The eslint config itself contains the banned tokens inside the
    // regex string that bans them — self-reference loop.
    "eslint.config.mjs",
  ]),
]);

export default eslintConfig;
