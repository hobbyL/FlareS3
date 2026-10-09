/**
 * 段级清洗：去控制字符、trim；空段返回 ''（由调用方过滤）。
 * `.`/`..` 语义上应剔除，但为保持文件名回退行为，仅目录段由 buildR2Key 剔除。
 */
function sanitizeKeySegment(segment: string): string {
  let safe = ''
  for (const char of String(segment ?? '')) {
    const code = char.charCodeAt(0)
    safe += code <= 0x1f || code === 0x7f ? '' : char
  }
  return safe.trim()
}

export function sanitizeFilename(filename: string): string {
  const normalized = String(filename ?? '').replaceAll('\\', '/')
  let withoutControls = ''
  for (const char of normalized) {
    const code = char.charCodeAt(0)
    withoutControls += code <= 0x1f || code === 0x7f ? '/' : char
  }
  const parts = withoutControls.split('/').filter(Boolean)
  const base = parts.length ? parts[parts.length - 1] : withoutControls
  const safe = String(base || '').trim()
  return safe || 'file'
}

export function sanitizeContentDispositionFilename(filename: string): string {
  return sanitizeFilename(filename).replaceAll('"', '')
}

export function extractR2ConfigIdFromKey(r2Key: string): string | null {
  const parts = r2Key.split('/').filter(Boolean)
  if (parts.length < 3) {
    return null
  }
  if (parts[0] !== 'flares3') {
    return null
  }
  return parts[1] || null
}

/**
 * 构造 R2 对象键：`flares3/<configId>/<dir...>/<filename>`。
 *
 * 目录段与文件名段逐段清洗后 join——`a/b/file.txt` 保留 `a/b`
 * （与 `storage/<configId>/<path>` 服务端中转口径一致，目录化视图据此归档）。
 * `.`/`..`/空段剔除；全空兜底 `file`。
 */
export function buildR2Key(configId: string, filename: string): string {
  const safeConfigId = String(configId).replaceAll('/', '_')
  const normalized = String(filename ?? '').replaceAll('\\', '/')
  const segments = normalized
    .split('/')
    .map(sanitizeKeySegment)
    .filter((segment) => segment && segment !== '.' && segment !== '..')
  if (!segments.length) {
    return `flares3/${safeConfigId}/file`
  }
  return `flares3/${safeConfigId}/${segments.join('/')}`
}
