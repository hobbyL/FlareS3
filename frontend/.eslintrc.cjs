const vue = require('eslint-plugin-vue')

module.exports = {
  root: true,
  ignorePatterns: ['node_modules/', 'dist/'],
  env: { browser: true, es2022: true },
  overrides: [
    {
      files: ['src/**/*.js'],
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      extends: ['eslint:recommended'],
      rules: {
        'no-unused-vars': 'off',
      },
    },
    {
      files: ['src/**/*.vue'],
      env: { browser: true, es2022: true },
      parser: 'vue-eslint-parser',
      parserOptions: {
        parser: 'espree',
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      plugins: ['vue'],
      extends: ['eslint:recommended', 'prettier'],
      rules: {
        // 10.8 的 legacy extends 指向导出 default 包装的内部模块。
        // 从插件公开 configs 取规则，保留完整 Vue 3 essential 检查。
        ...vue.configs.base.rules,
        ...vue.configs.essential.rules,
        'no-unused-vars': 'off',
        'vue/multi-word-component-names': 'off',
      },
    },
  ],
}
