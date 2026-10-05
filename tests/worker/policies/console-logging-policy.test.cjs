const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(process.cwd(), "..");
const workerSrcRoot = path.join(repoRoot, "worker", "src");

/**
 * 完全豁免：logStructured 管线自身的输出通道，允许任意 console.* 级别。
 */
const FULLY_EXEMPT_FILES = new Set(["utils/log.ts"]);

/**
 * 模块 tag 形态豁免：仅允许 console.error / console.warn 且首参为 '[tag]' 字符串字面量。
 *
 * - 上游/provider 失败的固定文案日志（storage-security spec：错误详情仅进服务端日志）
 * - 吞错点补日志（fileShareDownload 502 / files provider.delete / multipart 直链回退）
 */
const MODULE_TAG_EXEMPT_FILES = new Set([
  "index.ts", // [health] 公开端点 D1 错误详情仅进服务端日志（有意设计）
  "routes/mount.ts", // [mount] 上游失败固定文案（spec 契约）
  "routes/storageConfigs.ts", // [storageConfigs.reveal] 审计失败日志
  "routes/upload/server.ts", // [serverUpload] 上游失败固定文案
  "routes/files.ts", // [files] provider.delete 吞错点（非 404 补 warn）
  "routes/upload/multipart.ts", // [multipart] 直链回退吞错点
  "services/filePreview.ts", // [filePreview] 上游失败固定文案（spec 契约）
  "services/fileShareDownload.ts", // [fileShareDownload] 共享下载 502 吞错点
]);

function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function findConsoleCalls(source) {
  const calls = [];
  const pattern =
    /console\.(log|debug|info|warn|error)\s*\(\s*('([^']*)'|"([^"]*)")?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    calls.push({
      method: match[1],
      firstArg: match[3] ?? match[4] ?? null,
    });
  }
  return calls;
}

test("worker 生产代码不允许出现裸 console.* 调用", () => {
  const violations = [];

  for (const filePath of listSourceFiles(workerSrcRoot)) {
    const relative = path
      .relative(workerSrcRoot, filePath)
      .split(path.sep)
      .join("/");
    if (FULLY_EXEMPT_FILES.has(relative)) continue;

    const calls = findConsoleCalls(fs.readFileSync(filePath, "utf8"));
    for (const call of calls) {
      if (!MODULE_TAG_EXEMPT_FILES.has(relative)) {
        violations.push(
          `${relative}: 非豁免文件出现 console.${call.method}，应改用 logStructured`,
        );
        continue;
      }
      if (call.method !== "error" && call.method !== "warn") {
        violations.push(
          `${relative}: 豁免文件仅允许 console.error/warn，发现 console.${call.method}`,
        );
        continue;
      }
      if (!call.firstArg || !call.firstArg.startsWith("[")) {
        violations.push(
          `${relative}: console.${call.method} 首参必须是 '[模块 tag]' 字符串字面量`,
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("吞错点必须保留模块 tag 日志（fileShareDownload / files / multipart）", () => {
  const fileShareDownload = fs.readFileSync(
    path.join(workerSrcRoot, "services", "fileShareDownload.ts"),
    "utf8",
  );
  assert.match(
    fileShareDownload,
    /console\.error\('\[fileShareDownload\] provider download failed'/,
  );
  assert.match(
    fileShareDownload,
    /console\.error\('\[fileShareDownload\] r2 presigned download failed'/,
  );

  const filesRoute = fs.readFileSync(
    path.join(workerSrcRoot, "routes", "files.ts"),
    "utf8",
  );
  const filesWarnCount = (
    filesRoute.match(/\[files\] provider delete failed/g) || []
  ).length;
  assert.ok(
    filesWarnCount >= 2,
    `files.ts 两处 provider.delete 吞错点均需 warn 日志，实际 ${filesWarnCount} 处`,
  );
  // 非 404 才告警的判定必须存在，避免远端已缺失对象的预期路径刷告警
  assert.match(filesRoute, /isRemoteObjectMissingError/);

  const multipart = fs.readFileSync(
    path.join(workerSrcRoot, "routes", "upload", "multipart.ts"),
    "utf8",
  );
  assert.match(
    multipart,
    /console\.warn\('\[multipart\] direct download url failed'/,
  );
});
