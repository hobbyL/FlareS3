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

test("FolderShareModal 对文件夹分享链接提供二维码展示", () => {
  assert.match(source, /import QRCode from 'qrcode'/, "应复用 qrcode 依赖");
  assert.match(
    source,
    /QRCode\.toDataURL\(url, \{\s*errorCorrectionLevel: 'M',\s*margin: 1,\s*width: 280,/,
    "二维码渲染参数应与 FileShareModal 保持一致风格",
  );
  assert.match(
    source,
    /:disabled="!shareUrl \|\| saving"[\s\S]*@click="showQr"/,
    "无 shareUrl 时二维码入口应禁用",
  );
});

test("FolderShareModal 二维码仅在分享存在时出码且复用公开目录链接", () => {
  // 二维码按钮位于 v-if="share" 的链接区块内，分享不存在时整块不渲染
  assert.match(
    source,
    /<div v-if="share" class="link-group">[\s\S]*@click="showQr"[\s\S]*<\/div>/,
    "二维码入口应与复制按钮同处于分享存在时才渲染的链接区块",
  );
  assert.match(
    source,
    /\/f\/\$\{code\}/,
    "二维码应对公开目录页 /f/:code 链接出码",
  );
});

test("FolderShareModal 二维码文案走 mount.shareFolder i18n 键", () => {
  for (const key of ["qrShow", "qrTitle", "qrFailed", "qrTooLarge"]) {
    assert.match(
      source,
      new RegExp(`mount\\.shareFolder\\.${key}`),
      `缺少 i18n 键 mount.shareFolder.${key} 的引用`,
    );
  }
});
