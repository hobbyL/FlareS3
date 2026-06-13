import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../frontend/src/components/files/fileTableColumns.js",
    import.meta.url,
  ),
  "utf8",
);

const getColumnBlock = (key) => {
  const keyPattern = `key: '${key}'`;
  const keyIndex = source.indexOf(keyPattern);
  assert.notEqual(keyIndex, -1, `未找到列定义: ${key}`);

  const objectStart = source.lastIndexOf("{", keyIndex);
  assert.notEqual(objectStart, -1, `未找到列起始位置: ${key}`);

  let depth = 0;
  let inString = false;
  let stringQuote = "";

  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    const prevChar = source[index - 1];

    if (inString) {
      if (char === stringQuote && prevChar !== "\\") {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(objectStart, index + 1);
      }
    }
  }

  assert.fail(`未找到列结束位置: ${key}`);
};

test("Files 表格为易溢出的文本列显式启用省略号", () => {
  for (const key of [
    "filename",
    "size",
    "expires_in",
    "remaining_time",
    "owner",
  ]) {
    assert.match(
      getColumnBlock(key),
      /ellipsis:\s*true/,
      `${key} 列应显式启用 ellipsis`,
    );
  }
});

test("Files 表格仅对非文本操作列保留关闭省略号", () => {
  assert.match(
    getColumnBlock("status"),
    /ellipsis:\s*false/,
    "status 列应保留 ellipsis: false",
  );
  assert.match(
    getColumnBlock("actions"),
    /ellipsis:\s*false/,
    "actions 列应保留 ellipsis: false",
  );
});
