import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("上传进度回调用 total>0 防护，total 缺失时百分比不再产生 NaN", () => {
  const source = readSource("../../../frontend/src/services/api.js");

  assert.match(
    source,
    /const createUploadProgressHandler = \(onProgress\) =>/,
    "应提取统一的上传进度回调构造器",
  );
  assert.match(
    source,
    /total > 0 \? Math\.round\(\(loaded \* 100\) \/ total\) : 0/,
    "total 缺失或为 0 时百分比应置 0，避免 NaN",
  );
  assert.match(
    source,
    /Number\(progressEvent\?\.total\) \|\| 0/,
    "total 应做数值化与缺省归零处理",
  );

  const wiredCount =
    source.match(
      /onUploadProgress: createUploadProgressHandler\(onProgress\)/g,
    ) || [];
  assert.equal(
    wiredCount.length,
    3,
    "serverUpload / uploadMountedObject / uploadToR2 三处上传均应接入防护",
  );

  // 旧的裸计算写法不应残留
  assert.doesNotMatch(
    source,
    /Math\.round\(\(progressEvent\.loaded \* 100\) \/ progressEvent\.total\)/,
  );
});
