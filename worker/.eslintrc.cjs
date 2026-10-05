module.exports = {
  root: true,
  ignorePatterns: ['node_modules/', '.wrangler/'],
  env: { es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'prettier'],
  rules: {
    'no-undef': 'off',
    'no-unused-vars': 'off',
    // TS 重载签名会被该规则误报为重复成员（@typescript-eslint 推荐配置同样关闭它）
    'no-dupe-class-members': 'off',
  },
}

