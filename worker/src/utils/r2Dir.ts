/**
 * r2_key 目录提取口径（文件页目录化视图）。
 *
 * 目录信息完全来自 files.r2_key + files.config_id，无专用 DB 列。
 * 存在三种 r2_key 形态（见 .trellis/tasks/10-09-files-folder-view/design.md §2）：
 *   - `flares3/<configId>/<filename>`      R2 预签名/分片（dir 当前被 buildR2Key 剥离→根）
 *   - `storage/<configId>/<dir...>/<file>` 服务端中转（dir 保留）
 *   - legacy（config_id 为 NULL 等）         视为根
 *
 * 口径对三种形态统一：剥离 `<prefix>/<configId>/` 后，去掉末段文件名，
 * 余下即目录；无目录段则为根（空串）。前向兼容：若 flares3 路径将来保留
 * dir，同一口径会自动把它归入目录。
 */

const KNOWN_PREFIXES = new Set(['flares3', 'storage'])

/**
 * 归一化 `dir` 查询参数（与上传侧 sanitizeDir 同口径）。
 *
 * 去首尾/折叠多余 `/`、反斜杠转正斜杠；拒绝 `.`/`..` 段与空值 → 返回 `''`。
 * 返回 `''` 表示「无目录过滤」（根视图 / 全量）。
 */
export function normalizeDirParam(dir: unknown): string {
  const trimmed = String(dir ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
  if (!trimmed || trimmed === '.' || trimmed === '/') return ''
  let clean = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  clean = clean.endsWith('/') ? clean.slice(0, -1) : clean
  if (!clean || clean === '.' || clean === '..') return ''
  const segments = clean.split('/')
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return ''
  return clean
}

/**
 * 从 r2_key 提取目录字符串（根目录返回空串）。
 *
 * @param r2Key 文件存储键
 * @param configId files.config_id（可空）；用于核对前缀中的 config 段
 * @returns 归一后的目录（如 `a/b`），根目录为 `''`
 */
export function extractDirFromR2Key(r2Key: unknown, configId?: unknown): string {
  const parts = String(r2Key ?? '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 3) {
    // `<prefix>/<config>/<file>` 至少 3 段才可能有目录；不足即根
    return ''
  }
  if (!KNOWN_PREFIXES.has(parts[0])) {
    // legacy / 未知前缀 → 根
    return ''
  }

  // 优先用 config_id 核对第二段（映射 `/`→`_`，镜像 key 构造）；
  // 不匹配时仍按位置剥 2 段（口径稳健，不抛错）。
  const cid = String(configId ?? '').replaceAll('/', '_')
  void cid // 位置剥离已足够，cid 仅作核对意图，保留以示口径来源

  const rest = parts.slice(2)
  if (rest.length <= 1) {
    // 仅剩文件名 → 根
    return ''
  }
  return rest.slice(0, -1).join('/')
}

/**
 * 把目录展开为自身及全部祖先前缀。
 *
 * @example collectDirAncestors('a/b/c') => ['a', 'a/b', 'a/b/c']
 * @param dir 目录字符串（根 `''` 返回空数组）
 */
export function collectDirAncestors(dir: unknown): string[] {
  const segments = String(dir ?? '')
    .split('/')
    .filter(Boolean)
  const result: string[] = []
  let prefix = ''
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    result.push(prefix)
  }
  return result
}
