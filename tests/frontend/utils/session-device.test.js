import test from "node:test";
import assert from "node:assert/strict";

import { describeUserAgent } from "../../../frontend/src/utils/sessionDevice.js";

test("describeUserAgent classifies common desktop UA strings", () => {
  const windowsChrome = describeUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  );
  assert.deepEqual(windowsChrome, {
    device: "Windows",
    browser: "Chrome 129.0.0.0",
  });

  const macSafari = describeUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  );
  assert.deepEqual(macSafari, { device: "macOS", browser: "Safari 17.6" });

  const linuxFirefox = describeUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  );
  assert.deepEqual(linuxFirefox, { device: "Linux", browser: "Firefox 130.0" });
});

test("describeUserAgent classifies mobile UA strings", () => {
  // Android UA 含 Linux，窄规则必须优先
  const androidChrome = describeUserAgent(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  );
  assert.deepEqual(androidChrome, {
    device: "Android",
    browser: "Chrome 129.0.0.0",
  });

  // iPhone UA 含 Mac OS X，窄规则必须优先
  const iphoneSafari = describeUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  );
  assert.deepEqual(iphoneSafari, { device: "iOS", browser: "Safari 18.0" });

  const ipadSafari = describeUserAgent(
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  );
  assert.equal(ipadSafari.device, "iOS");
});

test("describeUserAgent disambiguates Chromium-based browsers that contain the Chrome token", () => {
  // Edge / Opera 的 UA 都包含 Chrome/xxx，不得被判成 Chrome
  const edge = describeUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.52",
  );
  assert.deepEqual(edge, { device: "Windows", browser: "Edge 129.0.2792.52" });

  const opera = describeUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0",
  );
  assert.deepEqual(opera, { device: "Windows", browser: "Opera 114.0.0.0" });
});

test("describeUserAgent falls back to empty strings for unusable input", () => {
  for (const input of [null, undefined, "", "   ", 42, {}, []]) {
    assert.deepEqual(
      describeUserAgent(input),
      { device: "", browser: "" },
      `输入 ${JSON.stringify(input)} 应返回空串占位`,
    );
  }

  // 可识别设备但浏览器未知：device 保留，browser 留空交由视图兜底
  const curl = describeUserAgent("curl/8.7.1");
  assert.deepEqual(curl, { device: "", browser: "" });

  const unknownBrowserOnWindows = describeUserAgent(
    "Mozilla/5.0 (Windows NT 10.0) SomeBot/1.0",
  );
  assert.deepEqual(unknownBrowserOnWindows, { device: "Windows", browser: "" });
});
