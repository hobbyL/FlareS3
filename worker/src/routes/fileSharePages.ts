import { buildPage, escapeHtml, htmlResponse } from './sharePage'

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
}: {
  title: string
  meta: string
  error?: string
}): Response {
  const errorHtml = error
    ? `<div class="alert alert-error" role="alert">
  <div class="alert-title">验证失败</div>
  <p class="alert-message">${escapeHtml(error)}</p>
</div>`
    : ''
  const html = buildPage({
    title,
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
      <button type="submit">下载文件</button>
    </form>
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}

export function renderFileConfirmPage({ title, meta }: { title: string; meta: string }): Response {
  const html = buildPage({
    title,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  <div class="centered">
    <p class="muted">点击下方按钮开始下载文件。</p>
    <form method="post">
      <button type="submit">下载文件</button>
    </form>
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}
