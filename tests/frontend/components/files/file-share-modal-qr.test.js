import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shareModalSource = readFileSync(
  new URL(
    "../../../../frontend/src/components/files/FileShareModal.vue",
    import.meta.url,
  ),
  "utf8",
);

const infoModalSource = readFileSync(
  new URL(
    "../../../../frontend/src/components/files/FileInfoModal.vue",
    import.meta.url,
  ),
  "utf8",
);

const uploadPanelSource = readFileSync(
  new URL(
    "../../../../frontend/src/components/upload/UploadResultPanel.vue",
    import.meta.url,
  ),
  "utf8",
);

test("FileShareModal 对常规分享链接提供二维码展示", () => {
  assert.match(
    shareModalSource,
    /import QRCode from 'qrcode'/,
    "应复用 qrcode 依赖",
  );
  assert.match(
    shareModalSource,
    /QRCode\.toDataURL\(url, \{\s*errorCorrectionLevel: 'M',\s*margin: 1,\s*width: 280,/,
    "二维码渲染参数应与 TextQrModal 保持一致风格",
  );
  assert.match(
    shareModalSource,
    /:disabled="!shareUrl \|\| saving"[\s\S]*@click="showQr"/,
    "未创建分享（无 shareUrl）时二维码入口应禁用",
  );
  // 明确不引入一次性分享能力：二维码只对常规 /f/:code 链接出码
  assert.ok(
    !shareModalSource.includes("one-time-share") &&
      !shareModalSource.includes("oneTimeShare"),
    "文件分享二维码不得引入一次性分享语义",
  );
});

test("直链区块在两处入口都带需登录语义提示", () => {
  assert.match(
    uploadPanelSource,
    /t\('upload\.directLinkHint'\)/,
    "上传结果面板应在直链区块下展示需登录提示",
  );
  assert.match(
    infoModalSource,
    /t\('upload\.directLinkHint'\)/,
    "文件详情弹窗应在直链区块下展示需登录提示",
  );
});
