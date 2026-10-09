// CSP nonce 内部约定头定义在 middleware/securityHeaders.ts（生成方），渲染侧只复用该常量
import { CSP_NONCE_HEADER } from '../middleware/securityHeaders'

/**
 * 生成 per-request CSP nonce。
 *
 * 用 crypto.getRandomValues（16 字节 base64，128 位熵）而非 Math.random，
 * 保证 nonce 不可预测且每次渲染唯一，浏览器才会放行带该 nonce 的内联脚本。
 */
function generateCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * HTML 实体转义：防止页面标题、正文中的用户内容注入标记。
 *
 * @param value - 待转义的原始字符串
 * @returns 转义 & < > " ' 后的安全字符串
 */
function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 构造分享页 HTML 响应。
 *
 * 当页面内联脚本带 nonce 时，同步通过内部约定头把 nonce 传给
 * withCommonHeaders，供其生成 script-src 'nonce-...' 指令并在最终响应前移除该头。
 *
 * @param html - 完整页面 HTML 字符串
 * @param status - HTTP 状态码（默认 200）
 * @returns HTML 响应（Content-Type: text/html，Cache-Control: no-store）
 */
function htmlResponse(html: string, status = 200): Response {
  // 页面内联脚本带 nonce 时同步携带约定头，供 withCommonHeaders 生成 CSP nonce 指令
  const nonceMatch = html.match(/<script nonce="([^"]+)"/)
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(nonceMatch ? { [CSP_NONCE_HEADER]: nonceMatch[1] } : {}),
    },
  })
}

export { buildPage, escapeHtml, htmlResponse }

/**
 * 渲染分享页骨架：head 内联主题/口令交互脚本（每次渲染生成新 nonce）+ 公共样式。
 *
 * @param title - 页面标题（自动转义）
 * @param body - 页面主体 HTML（调用方负责对动态内容转义）
 * @returns 完整 HTML 文档字符串
 */
function buildPage({ title, body }: { title: string; body: string }): string {
  const nonce = generateCspNonce()
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <script nonce="${nonce}">
    (() => {
      try {
        const key = 'flares3:theme'
        const stored = window.localStorage.getItem(key)
        const mode =
          stored === 'dark' || stored === 'light'
            ? stored
            : window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
              ? 'dark'
              : 'light'

        document.documentElement.dataset.theme = mode
        document.documentElement.style.colorScheme = mode

        const uiThemeKey = 'flares3:ui-theme'
        const defaultUiTheme = 'motherduck-neobrutalism'
        const uiThemes = [defaultUiTheme, 'shadcn']
        const storedUiTheme = window.localStorage.getItem(uiThemeKey)
        const uiTheme = uiThemes.includes(storedUiTheme) ? storedUiTheme : defaultUiTheme
        document.documentElement.dataset.uiTheme = uiTheme

        window.addEventListener('DOMContentLoaded', () => {
          const toggles = document.querySelectorAll('[data-toggle-password]')
          toggles.forEach((button) => {
            if (!(button instanceof HTMLButtonElement)) return
            button.addEventListener('click', () => {
              const targetId = button.dataset.target || 'password'
              const input = document.getElementById(targetId)
              if (!(input instanceof HTMLInputElement)) return
              const nextType = input.type === 'password' ? 'text' : 'password'
              input.type = nextType
              const pressed = nextType === 'text'
              button.setAttribute('aria-pressed', String(pressed))
              button.textContent = pressed ? '隐藏' : '显示'
              input.focus()
            })
          })
        })
      } catch {
        // ignore
      }
    })()
  </script>
  <style>
    :root {
      color-scheme: light dark;

      --share-bg: #f4efea;
      --share-card: #ffffff;
      --share-text: #383838;
      --share-muted: #6b6b6b;
      --share-border: #383838;
      --share-border-width: 2px;
      --share-shadow: -5px 5px 0px 0px #383838;
      --share-radius: 2px;
      --share-primary: #ffde00;
      --share-primary-text: #383838;
      --share-code-bg: rgba(248, 248, 247, 0.7);
    }

    :root[data-ui-theme='motherduck-neobrutalism'][data-theme='dark'] {
      --share-bg: #0f0f10;
      --share-card: #171717;
      --share-text: #f4efea;
      --share-muted: #c7c1bc;
      --share-border: #f4efea;
      --share-border-width: 2px;
      --share-shadow: -5px 5px 0px 0px #f4efea;
      --share-radius: 2px;
      --share-primary: #ffde00;
      --share-primary-text: #383838;
      --share-code-bg: rgba(23, 23, 23, 0.75);
    }

    :root[data-ui-theme='shadcn'] {
      color-scheme: light;

      --share-bg: oklch(1 0 0);
      --share-card: oklch(1 0 0);
      --share-text: oklch(0.145 0 0);
      --share-muted: oklch(0.556 0 0);
      --share-border: oklch(0.922 0 0);
      --share-border-width: 1px;
      --share-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
      --share-radius: 16px;
      --share-primary: oklch(0.205 0 0);
      --share-primary-text: oklch(0.985 0 0);
      --share-code-bg: oklch(0.97 0 0);
    }

    :root[data-ui-theme='shadcn'][data-theme='dark'] {
      color-scheme: dark;

      --share-bg: oklch(0.145 0 0);
      --share-card: oklch(0.205 0 0);
      --share-text: oklch(0.985 0 0);
      --share-muted: oklch(0.708 0 0);
      --share-border: oklch(1 0 0 / 10%);
      --share-border-width: 1px;
      --share-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
      --share-radius: 16px;
      --share-primary: oklch(0.922 0 0);
      --share-primary-text: oklch(0.205 0 0);
      --share-code-bg: oklch(0.269 0 0);
    }

    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      background: var(--share-bg);
      color: var(--share-text);
    }

    .wrap {
      max-width: 980px;
      margin: 0 auto;
      padding: 40px 16px 64px;
    }

    .card {
      border: var(--share-border-width) solid var(--share-border);
      border-radius: var(--share-radius);
      background: var(--share-card);
      box-shadow: var(--share-shadow);
      overflow: hidden;
    }

    .header {
      padding: 20px 24px;
      border-bottom: var(--share-border-width) solid var(--share-border);
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }

    .title {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      color: var(--share-muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .body {
      padding: 20px 24px;
    }

    .centered {
      max-width: 560px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      align-items: center;
    }

    .centered > * {
      width: 100%;
      max-width: 420px;
    }

    .centered > .muted {
      text-align: center;
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 13px;
      line-height: 1.65;
      color: var(--share-text);
      background: var(--share-code-bg);
      border: var(--share-border-width) solid var(--share-border);
      border-radius: calc(var(--share-radius) + 2px);
      padding: 14px 16px;
    }

    .muted {
      color: var(--share-muted);
      font-size: 14px;
      line-height: 1.6;
      margin: 0;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 420px;
    }

    .input-group {
      display: flex;
      align-items: stretch;
      gap: 10px;
    }

    .input-group > input {
      flex: 1;
    }

    label {
      font-size: 13px;
      color: var(--share-muted);
    }

    input {
      width: 100%;
      padding: 12px 14px;
      border: var(--share-border-width) solid var(--share-border);
      border-radius: calc(var(--share-radius) + 2px);
      background: var(--share-card);
      color: var(--share-text);
      outline: none;
    }

    input::placeholder {
      color: color-mix(in oklab, var(--share-muted) 70%, transparent);
    }

    input:focus {
      box-shadow: 0 0 0 4px color-mix(in oklab, var(--share-primary) 25%, transparent);
    }

    button {
      padding: 12px 14px;
      border: var(--share-border-width) solid var(--share-border);
      border-radius: calc(var(--share-radius) + 2px);
      background: var(--share-primary);
      color: var(--share-primary-text);
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, filter 120ms ease;
    }

    button:hover {
      filter: brightness(0.98);
    }

    button:active {
      transform: translateY(1px);
    }

    button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 4px color-mix(in oklab, var(--share-primary) 25%, transparent);
    }

    .toggle-btn {
      padding: 12px 12px;
      background: color-mix(in oklab, var(--share-card) 92%, var(--share-primary));
      color: var(--share-text);
      font-weight: 600;
      min-width: 72px;
    }

    .error {
      margin: 0;
      color: #fb7185;
      font-size: 13px;
    }

    .alert {
      border: var(--share-border-width) solid var(--share-border);
      border-radius: calc(var(--share-radius) + 2px);
      background: color-mix(in oklab, var(--share-primary) 7%, var(--share-card));
      padding: 12px 14px;
    }

    .alert-error {
      border-color: color-mix(in oklab, #fb7185 70%, var(--share-border));
      background: color-mix(in oklab, #fb7185 10%, var(--share-card));
    }

    .alert-title {
      margin: 0 0 4px;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: -0.01em;
    }

    .alert-message {
      margin: 0;
      font-size: 13px;
      color: var(--share-muted);
      line-height: 1.5;
    }

    .hint {
      margin: 0;
      font-size: 12px;
      color: var(--share-muted);
      line-height: 1.5;
    }

    /* ── folder 分享目录列表 ── */

    .dir-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 24px;
      border-bottom: var(--share-border-width) solid var(--share-border);
      background: color-mix(in oklab, var(--share-primary) 4%, var(--share-card));
    }

    .dir-path {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--share-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dir-list {
      list-style: none;
      margin: 0;
      padding: 8px 0;
    }

    .dir-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 24px;
    }

    .dir-row:hover {
      background: color-mix(in oklab, var(--share-primary) 5%, var(--share-card));
    }

    .dir-name {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
      font-size: 14px;
      color: var(--share-text);
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    a.dir-name:hover {
      text-decoration: underline;
    }

    .dir-icon {
      flex-shrink: 0;
      font-size: 14px;
    }

    .dir-meta {
      flex-shrink: 0;
      color: var(--share-muted);
      font-size: 12px;
    }

    .dir-download {
      flex-shrink: 0;
      padding: 8px 14px;
      font-size: 13px;
    }

    .dir-empty {
      margin: 0;
      padding: 28px 24px;
      text-align: center;
      color: var(--share-muted);
      font-size: 14px;
    }

    .dir-back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      padding: 6px 10px;
      border: var(--share-border-width) solid var(--share-border);
      border-radius: var(--share-radius);
      background: var(--share-card);
      color: var(--share-text);
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
    }

    a.dir-back:hover {
      background: color-mix(in oklab, var(--share-primary) 10%, var(--share-card));
    }

    .dir-row form {
      margin: 0;
      max-width: none;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      ${body}
    </div>
  </div>
</body>
</html>`
}
