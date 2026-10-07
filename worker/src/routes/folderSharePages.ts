import { buildPage, escapeHtml, htmlResponse } from './sharePage'

function buildListUrl(code: string, path: string): string {
  const encoded = encodeURIComponent(path)
  return encoded
    ? `/f/${encodeURIComponent(code)}?path=${encoded}`
    : `/f/${encodeURIComponent(code)}`
}

/** 取目录 path 的上一级（'docs/sub/' -> 'docs/'；顶层 -> ''） */
function parentDirectoryPath(path: string): string {
  const trimmed = String(path || '').trim()
  if (!trimmed) return ''
  const withoutTrailing = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  const index = withoutTrailing.lastIndexOf('/')
  return index >= 0 ? withoutTrailing.slice(0, index + 1) : ''
}

function getBasename(key: string): string {
  const normalized = String(key || '')
  const withoutTrailing = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  const index = withoutTrailing.lastIndexOf('/')
  return index >= 0 ? withoutTrailing.slice(index + 1) : withoutTrailing
}

export function renderFolderMessagePage(title: string, message: string, status = 200): Response {
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

export function renderFolderPasswordForm({
  code,
  title,
  meta,
  path,
  error,
}: {
  code: string
  title: string
  meta: string
  path: string
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
    <p class="muted">该目录需要访问口令。</p>
    ${errorHtml}
    <form method="post" action="${escapeHtml(buildListUrl(code, path))}">
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
      <button type="submit">访问目录</button>
    </form>
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}

/**
 * 渲染 folder 分享目录列表页。
 *
 * folders / objects 的 key 均为完整存储 key，渲染时剥离 sharePrefix
 * 还原为「相对分享根」的 path（GET 导航与 POST 下载都以相对 path 传递）。
 * 下载走 POST 表单（hidden path 字段），目录导航走 GET ?path=。
 */
export function renderFolderListPage({
  code,
  title,
  meta,
  path,
  sharePrefix,
  folders,
  objects,
}: {
  code: string
  title: string
  meta: string
  path: string
  sharePrefix: string
  folders: string[]
  objects: { key: string; size: number; last_modified?: string }[]
}): Response {
  const parentPath = parentDirectoryPath(path)
  const toRelativePath = (key: string): string =>
    key.startsWith(sharePrefix) ? key.slice(sharePrefix.length) : key

  const backHtml = path
    ? `<a class="dir-back" href="${escapeHtml(buildListUrl(code, parentPath))}">← 返回上一级</a>`
    : ''

  const folderRows = folders.map((folder) => {
    const name = getBasename(folder)
    return `
    <li class="dir-row">
      <a class="dir-name" href="${escapeHtml(buildListUrl(code, toRelativePath(folder)))}">
        <span class="dir-icon">📁</span>
        <span>${escapeHtml(name)}/</span>
      </a>
      <span class="dir-meta">目录</span>
    </li>`
  })

  const objectRows = objects.map((object) => {
    const name = getBasename(object.key)
    return `
    <li class="dir-row">
      <span class="dir-name">
        <span class="dir-icon">📄</span>
        <span>${escapeHtml(name)}</span>
      </span>
      <form method="post" action="${escapeHtml(buildListUrl(code, ''))}">
        <input type="hidden" name="path" value="${escapeHtml(toRelativePath(object.key))}" />
        <button type="submit" class="dir-download">下载</button>
      </form>
    </li>`
  })

  const emptyHtml =
    folders.length === 0 && objects.length === 0
      ? `<p class="dir-empty">该目录为空。</p>`
      : `<ul class="dir-list">${folderRows.join('')}${objectRows.join('')}</ul>`

  const html = buildPage({
    title,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="dir-toolbar">
  <p class="dir-path">/${escapeHtml(path)}</p>
  ${backHtml}
</div>
<div class="body">
  ${emptyHtml}
</div>`,
  })

  return htmlResponse(html, 200)
}
