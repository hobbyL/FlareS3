const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const { escapeLike } = require(path.join(COMPILED_ROOT, "utils/escapeLike.js"));

test("escapeLike 将 LIKE 通配符按字面转义", () => {
  assert.equal(escapeLike("普通文本"), "普通文本");
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  // 反斜杠本身先转义，防止拼出二次转义序列
  assert.equal(escapeLike("a\\b"), "a\\\\b");
  assert.equal(escapeLike("%_"), "\\%\\_");
  // 组合场景：搜索词含多种通配符
  assert.equal(escapeLike("50%_off"), "50\\%\\_off");
});

test("escapeLike 对空值与非法输入保持健壮", () => {
  assert.equal(escapeLike(""), "");
  assert.equal(escapeLike(null), "");
  assert.equal(escapeLike(undefined), "");
});
