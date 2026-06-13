import test from "node:test";
import assert from "node:assert/strict";

import { resolveUploadErrorMessage } from "../../../frontend/src/utils/uploadErrors.js";

test("resolveUploadErrorMessage prefers structured backend upload error message", () => {
  const message = resolveUploadErrorMessage(
    {
      response: {
        data: {
          error: {
            code: "UPLOAD_FILE_TOO_LARGE",
            message: "文件大小超过限制",
          },
        },
      },
    },
    "上传失败",
  );

  assert.equal(message, "文件大小超过限制");
});

test("resolveUploadErrorMessage falls back to legacy payload and runtime error message", () => {
  assert.equal(
    resolveUploadErrorMessage(
      {
        response: {
          data: {
            error: "超出配额",
          },
        },
      },
      "上传失败",
    ),
    "超出配额",
  );

  assert.equal(
    resolveUploadErrorMessage(new Error("network down"), "上传失败"),
    "network down",
  );
  assert.equal(resolveUploadErrorMessage({}, "上传失败"), "上传失败");
});
