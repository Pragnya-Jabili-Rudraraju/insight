const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "coverage/**"] },
  {
    files: ["src/**/*.js", "test/**/*.js", "evaluation/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.jest }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": ["error", { allow: ["error", "warn"] }]
    }
  }
];
