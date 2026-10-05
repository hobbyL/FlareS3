// tests/frontend 测试文件的 ESLint 配置。
// tests/ 位于 frontend/ 目录之外，ESLint 的配置级联查找不会进入 frontend/，
// 且仓库策略（tests/worker/policies/repository-policy.test.cjs）要求
// tests/frontend 根目录不落任何文件，故由 lint script 以
// `--no-eslintrc --config` 显式指向本文件。规则强度与 .eslintrc.cjs 中
// src/**/*.js 的 override 等价（eslint:recommended），仅 env 按 node:test
// 运行环境调整；不 extends 第三方配置，插件解析只依赖 frontend/node_modules。
module.exports = {
  root: true,
  ignorePatterns: ['node_modules/'],
  env: { node: true, browser: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': 'off',
  },
}
