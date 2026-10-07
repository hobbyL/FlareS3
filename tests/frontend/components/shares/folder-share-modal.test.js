import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/mount/FolderShareModal.vue",
    import.meta.url,
  ),
  "utf8",
);

test("FolderShareModal 按挂载点与前缀查询现有分享", () => {
  assert.match(
    source,
    /api\.getFolderShare\(\{\s*config_id:\s*configId,\s*prefix:\s*normalizedPrefix\.value,\s*\}\)/,
    "打开弹窗时应以 config_id + prefix 查询现有文件夹分享",
  );
  assert.match(
    source,
    /watch\(\s*\(\)\s*=>\s*props\.show[\s\S]*\{\s*immediate:\s*true\s*\}/,
    "props.show watcher 需要 immediate: true，否则 v-if 首次挂载不会加载分享数据",
  );
  assert.match(
    source,
    /watch\(\s*\(\)\s*=>\s*\[props\.configId,\s*props\.prefix\]/,
    "config_id 或 prefix 变化时应重新加载分享",
  );
  assert.match(
    source,
    /share\.value = result\?\.share \|\| null/,
    "查询结果应取 share 字段",
  );
});

test("FolderShareModal 创建与撤销走管理端点且校验表单", () => {
  assert.match(
    source,
    /const payload = buildPayload\(\)/,
    "创建前应先构造并校验 payload",
  );
  assert.match(
    source,
    /max_views: Math\.floor\(maxViews\)/,
    "创建 payload 应携带取整后的 max_views",
  );
  assert.match(
    source,
    /api\.createFolderShare\(payload\)/,
    "创建分享应调用 api.createFolderShare",
  );
  assert.match(
    source,
    /api\.deleteFolderShare\(\{\s*config_id:\s*configId,\s*prefix:\s*normalizedPrefix\.value,\s*\}\)/,
    "撤销分享应按 config_id + prefix 调用 api.deleteFolderShare",
  );
  assert.match(
    source,
    /message\.error\(t\('mount\.shareFolder\.maxViewsInvalid'\)\)/,
    "非法访问次数应提示 i18n 文案",
  );
  assert.match(
    source,
    /message\.error\(t\('mount\.shareFolder\.expiresRequired'\)\)/,
    "自定义有效期缺失时应提示 i18n 文案",
  );
});

test("FolderShareModal 分享存在时展示统计与链接，复制失败可恢复", () => {
  assert.match(source, /\/f\/\$\{code\}/, "分享链接应指向公开目录页 /f/:code");
  assert.match(
    source,
    /share\.value = null/,
    "撤销成功后应清空 share 回到创建表单",
  );
  assert.match(
    source,
    /message\.error\(t\('mount\.shareFolder\.copyFailed'\)\)/,
    "复制失败应提示 i18n 文案",
  );
  for (const key of [
    "title",
    "scopeLabel",
    "loading",
    "statsVisits",
    "statsValidity",
    "passwordStatus",
    "fieldsValidity",
    "fieldsAccessCount",
    "fieldsSharePassword",
    "optional",
    "neverExpires",
    "expire1d",
    "expire7d",
    "expire30d",
    "expireCustom",
    "link",
    "unlimited",
    "passwordSet",
    "passwordUnset",
    "create",
    "disable",
    "createSuccess",
    "createFailed",
    "disableSuccess",
    "disableFailed",
    "copyFailed",
    "loadFailed",
    "expiresRequired",
    "maxViewsInvalid",
  ]) {
    assert.match(
      source,
      new RegExp(`mount\\.shareFolder\\.${key}`),
      `缺少 i18n 键 mount.shareFolder.${key} 的引用`,
    );
  }
});
