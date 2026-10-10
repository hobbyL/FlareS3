import { buildPage, escapeHtml, htmlResponse, type ShareOgMeta } from './sharePage'

export function renderFileMessagePage(title: string, message: string, status = 200): Response {
  const html = buildPage({
    title,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta"></div>
</div>
<div class="body">
  <p class="muted">${escapeHtml(message)}</p>
</div>`,
  })

  return htmlResponse(html, status)
}

export function renderFilePasswordForm({
  title,
  meta,
  error,
  og,
  canPreview = false,
}: {
  title: string
  meta: string
  error?: string
  og?: ShareOgMeta
  canPreview?: boolean
}): Response {
  const errorHtml = error
    ? `<div class="alert alert-error" role="alert">
  <div class="alert-title">验证失败</div>
  <p class="alert-message">${escapeHtml(error)}</p>
</div>`
    : ''
  // 可预览文件提供两个提交动作：在线查看（POST ?inline=1，消费一次后内联渲染）/
  // 下载文件（默认 action，消费一次后附件响应）。两者各消费恰好一次。
  const inlineButton = canPreview
    ? `<button type="submit" formaction="?inline=1">在线查看</button>`
    : ''
  const html = buildPage({
    title,
    og,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  <div class="centered">
    <p class="muted">该文件需要访问口令。</p>
    ${errorHtml}
    <form method="post">
      <label for="password">访问口令</label>
      <div class="input-group">
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          placeholder="请输入访问口令"
          required
          autofocus
        />
        <button
          type="button"
          class="toggle-btn"
          data-toggle-password
          data-target="password"
          aria-pressed="false"
        >
          显示
        </button>
      </div>
      <p class="hint">口令区分大小写；输入后按回车即可。</p>
      ${inlineButton}
      <button type="submit">下载文件</button>
    </form>
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}

export function renderFileConfirmPage({
  title,
  meta,
  og,
  canPreview = false,
}: {
  title: string
  meta: string
  og?: ShareOgMeta
  canPreview?: boolean
}): Response {
  const inlineButton = canPreview
    ? `<button type="submit" formaction="?inline=1">在线查看</button>`
    : ''
  const prompt = canPreview ? '点击在线查看，或下载文件。' : '点击下方按钮开始下载文件。'
  const html = buildPage({
    title,
    og,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  <div class="centered">
    <p class="muted">${prompt}</p>
    <form method="post">
      ${inlineButton}
      <button type="submit">下载文件</button>
    </form>
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}

/**
 * 渲染文件分享内联图片预览页（data: URI 内嵌 `<img>`）。
 *
 * src 为调用方以声明类型 + base64 字节拼成的 data: URI；无二次下载按钮
 * （避免二次消费访问次数）。CSP 的 `img-src data:` 放行该内嵌。
 */
export function renderFileImagePreviewPage({
  title,
  meta,
  og,
  src,
  filename,
}: {
  title: string
  meta: string
  og?: ShareOgMeta
  src: string
  filename: string
}): Response {
  const html = buildPage({
    title,
    og,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  <div class="preview-media">
    <img class="preview-image" src="${escapeHtml(src)}" alt="${escapeHtml(filename)}" />
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}

/**
 * 渲染文件分享内联文本预览页（escapeHtml 后 `<pre>`）。
 *
 * 内容超限时按字节截断并提示；无二次下载按钮（避免二次消费访问次数）。
 */
export function renderFileTextPreviewPage({
  title,
  meta,
  og,
  content,
  truncated = false,
}: {
  title: string
  meta: string
  og?: ShareOgMeta
  content: string
  truncated?: boolean
}): Response {
  const truncatedHint = truncated ? `<p class="hint">内容较大，仅显示前 256 KB。</p>` : ''
  const html = buildPage({
    title,
    og,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  ${truncatedHint}
  <pre>${escapeHtml(content)}</pre>
</div>`,
  })

  return htmlResponse(html, 200)
}
