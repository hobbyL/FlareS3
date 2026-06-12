const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'])

export type PreviewMode =
  | { kind: 'redirect'; responseContentType: string }
  | { kind: 'proxy'; responseContentType: string }

export function normalizeContentType(value: unknown): string {
  return String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

export function getFilenameExtension(filename: unknown): string {
  const name = String(filename || '').trim()
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index + 1).toLowerCase()
}

export function isArchiveFile(contentType: string, extension: string): boolean {
  if (contentType && ARCHIVE_MIME_TYPES.has(contentType)) return true
  if (extension && ARCHIVE_EXTENSIONS.has(extension)) return true
  return false
}

export function formatUpstreamFetchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  const message = raw.replace(/\s+/g, ' ').trim()
  if (!message) return 'upstream_fetch_failed'
  return message.slice(0, 200)
}

export function resolvePreviewMode(contentType: string, extension: string): PreviewMode | null {
  if (contentType === 'application/pdf' || extension === 'pdf') {
    return { kind: 'redirect', responseContentType: 'application/pdf' }
  }

  if (contentType.startsWith('image/')) {
    return { kind: 'redirect', responseContentType: contentType }
  }

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) {
    const map: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    }
    return { kind: 'redirect', responseContentType: map[extension] || 'image/*' }
  }

  if (
    contentType === 'text/markdown' ||
    contentType === 'text/x-markdown' ||
    extension === 'md' ||
    extension === 'markdown'
  ) {
    return { kind: 'proxy', responseContentType: 'text/markdown; charset=utf-8' }
  }

  if (
    contentType.startsWith('text/') ||
    ['txt', 'log', 'csv', 'json', 'yml', 'yaml', 'ini', 'conf'].includes(extension)
  ) {
    return { kind: 'proxy', responseContentType: 'text/plain; charset=utf-8' }
  }

  return null
}
