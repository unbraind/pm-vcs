/**
 * Strict ESLint policy for every repository TypeScript file.
 *
 * Babel's maintained ESLint parser is used because the current typescript-eslint
 * release rejects the package's TypeScript 7 compiler peer range. TypeScript 7
 * remains the build and type-check compiler; Babel supplies only the ESTree AST
 * ESLint needs for syntax-aware policy enforcement.
 */

import babelParser from "@babel/eslint-parser";
import { defineConfig } from "eslint/config";

const forbiddenSyntax = [
  { selector: "TSAnyKeyword", message: "Use a precise type instead of explicit any." },
  { selector: "ImportExpression", message: "Dynamic imports are forbidden; use a top-level import." },
  { selector: "TSImportType", message: "Inline type imports are forbidden; use a top-level type import." },
  { selector: "TSParameterProperty", message: "Parameter properties require non-erasable emit." },
  { selector: "TSEnumDeclaration", message: "Enums require non-erasable emit; use literal unions." },
  { selector: "TSModuleDeclaration", message: "Namespaces and TypeScript modules are forbidden." },
  { selector: "TSImportEqualsDeclaration", message: "Import-equals syntax is forbidden." },
  { selector: "TSExportAssignment", message: "Export-equals syntax is forbidden." },
] as const;

export default defineConfig([
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [["@babel/plugin-syntax-typescript", { disallowAmbiguousJSXLike: true }]],
        },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "constructor-super": "error",
      "eqeqeq": ["error", "always"],
      "no-array-constructor": "error",
      "no-async-promise-executor": "error",
      "no-constant-binary-expression": "error",
      "no-constructor-return": "error",
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-dupe-else-if": "error",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "no-fallthrough": "error",
      "no-import-assign": "error",
      "no-new-native-nonconstructor": "error",
      "no-promise-executor-return": "error",
      "no-restricted-syntax": ["error", ...forbiddenSyntax],
      "no-self-assign": "error",
      "no-setter-return": "error",
      "no-shadow-restricted-names": "error",
      "no-sparse-arrays": "error",
      "no-unexpected-multiline": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable": "error",
      "no-unreachable-loop": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-optional-chaining": "error",
      "no-unused-private-class-members": "error",
      "no-useless-backreference": "error",
      "no-useless-catch": "error",
      "no-useless-escape": "error",
      "no-var": "error",
      "prefer-const": "error",
      "prefer-object-has-own": "error",
      "require-atomic-updates": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
    },
  },
]);
