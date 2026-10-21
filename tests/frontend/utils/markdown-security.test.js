import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderMarkdown } from "../../../frontend/src/utils/markdown.js";

test("Markdown 预览及时处理未闭合的多行引用定义", () => {
  // 隔离解析过程并设时限，避免依赖回退时阻塞整个测试进程。
  const rendererUrl = new URL(
    "../../../frontend/src/utils/markdown.js",
    import.meta.url,
  ).href;
  const code = `
    import { renderMarkdown } from ${JSON.stringify(rendererUrl)};
    const title = '[a]: /u "' + 'x\\n'.repeat(200000);
    const label = '[' + 'a\\n'.repeat(20000);
    for (const linkify of [false, true]) {
      for (const input of [title, label]) {
        const output = renderMarkdown(input, { linkify });
        if (!output || output.includes('<a ')) process.exit(1);
      }
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("Markdown 安全补丁保留正常引用链接和 HTML 转义", () => {
  const output = renderMarkdown(
    '[文档][docs]\n\n[docs]: https://example.com/docs "帮助"\n\n<script>alert(1)</script>',
  );
  assert.match(
    output,
    /<a href="https:\/\/example\.com\/docs" title="帮助">文档<\/a>/,
  );
  assert.doesNotMatch(output, /<script>/);
  assert.match(output, /&lt;script&gt;/);
});
