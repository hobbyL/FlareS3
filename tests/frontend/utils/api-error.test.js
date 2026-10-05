import test from "node:test";
import assert from "node:assert/strict";

import { resolveApiErrorNotice } from "../../../frontend/src/utils/apiError.js";
import { setLocale } from "../../../frontend/src/locales/index.js";

// node 环境无 window/localStorage，初始 locale 取决于全局 navigator.language，
// 兜底文案断言前先固定为 zh-CN；切语言的用例负责恢复
setLocale("zh-CN", { persist: false });

/**
 * 构造一个近似 axios 的错误对象。
 * @param {{ status?: number, data?: unknown, message?: string, url?: string, hasResponse?: boolean }} opts
 */
function makeError({
  status,
  data,
  message = "Request failed",
  url,
  hasResponse = true,
} = {}) {
  const error = { message };
  if (url !== undefined) error.config = { url };
  if (hasResponse) error.response = { status, data };
  return error;
}

test("401 非 auth 接口触发重定向", () => {
  const notice = resolveApiErrorNotice(makeError({ status: 401 }), {
    isAuthApi: false,
  });
  assert.deepEqual(notice, { action: "redirect" });
});

test("401 auth 接口交由调用方处理（静默）", () => {
  const notice = resolveApiErrorNotice(makeError({ status: 401 }), {
    isAuthApi: true,
  });
  assert.deepEqual(notice, { action: "silent" });
});

test("403 展示固定的权限不足文案", () => {
  const notice = resolveApiErrorNotice(
    makeError({ status: 403, data: { error: "forbidden" } }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "权限不足，无法执行此操作",
    type: "error",
  });
});

test("429 展示固定的限流文案（warning）", () => {
  const notice = resolveApiErrorNotice(makeError({ status: 429 }));
  assert.deepEqual(notice, {
    action: "notify",
    message: "请求过于频繁，请稍后再试",
    type: "warning",
  });
});

test("5xx：字符串错误体直接展示后端消息（普通路由形状）", () => {
  const notice = resolveApiErrorNotice(
    makeError({ status: 500, data: { error: "数据库连接失败" } }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "数据库连接失败",
    type: "error",
  });
});

test("5xx：对象错误体读取 message（上传路由形状）", () => {
  const notice = resolveApiErrorNotice(
    makeError({
      status: 502,
      data: { error: { code: "UPSTREAM", message: "网关错误" } },
    }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "网关错误",
    type: "error",
  });
});

test("5xx：无后端消息时回退中文兜底，而非 axios 英文 message", () => {
  const notice = resolveApiErrorNotice(
    makeError({
      status: 500,
      data: {},
      message: "Request failed with status code 500",
    }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "服务器错误，请稍后重试",
    type: "error",
  });
});

test("无 response：网络错误文案", () => {
  const notice = resolveApiErrorNotice(
    makeError({ hasResponse: false, message: "Network Error" }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "网络连接失败，请检查网络设置",
    type: "error",
  });
});

test("4xx：字符串错误体直接展示后端消息", () => {
  const notice = resolveApiErrorNotice(
    makeError({ status: 400, data: { error: "参数校验失败" } }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "参数校验失败",
    type: "error",
  });
});

test("4xx：对象错误体读取 message", () => {
  const notice = resolveApiErrorNotice(
    makeError({
      status: 404,
      data: { error: { code: "NOT_FOUND", message: "文件不存在" } },
    }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "文件不存在",
    type: "error",
  });
});

test("4xx：无后端消息时回退中文兜底", () => {
  const notice = resolveApiErrorNotice(
    makeError({
      status: 400,
      data: null,
      message: "Request failed with status code 400",
    }),
  );
  assert.deepEqual(notice, {
    action: "notify",
    message: "请求失败，请检查输入",
    type: "error",
  });
});

test("其余状态（如 3xx / 状态缺失但有 response）保持静默", () => {
  const redirectLike = resolveApiErrorNotice(
    makeError({ status: 302, data: {} }),
  );
  assert.deepEqual(redirectLike, { action: "silent" });

  const noStatus = resolveApiErrorNotice(
    makeError({ status: undefined, data: {} }),
  );
  assert.deepEqual(noStatus, { action: "silent" });
});

test("无 response 的错误（含空对象）按网络错误处理，且入参缺失不抛异常", () => {
  const emptyNotice = resolveApiErrorNotice({});
  assert.deepEqual(emptyNotice, {
    action: "notify",
    message: "网络连接失败，请检查网络设置",
    type: "error",
  });
  assert.doesNotThrow(() => resolveApiErrorNotice(undefined));
});

test("兜底文案随 locale 切换：en-US 下返回英文文案", () => {
  try {
    setLocale("en-US", { persist: false });

    assert.deepEqual(resolveApiErrorNotice(makeError({ status: 403 })), {
      action: "notify",
      message: "Permission denied. You are not allowed to perform this action.",
      type: "error",
    });
    assert.deepEqual(resolveApiErrorNotice(makeError({ status: 429 })), {
      action: "notify",
      message: "Too many requests. Please try again later.",
      type: "warning",
    });
    assert.deepEqual(resolveApiErrorNotice(makeError({ hasResponse: false })), {
      action: "notify",
      message: "Network connection failed. Please check your network settings.",
      type: "error",
    });
  } finally {
    setLocale("zh-CN", { persist: false });
  }
});
