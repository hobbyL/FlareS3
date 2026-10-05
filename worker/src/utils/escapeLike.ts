/**
 * LIKE 通配符转义。
 *
 * 用户搜索词中的 `%`/`_` 按字面匹配而非通配符，
 * 防止 `%` 全量匹配带来的性能放大与语义混乱。
 * 配套 SQL 子句须声明 `ESCAPE '\\'`。
 */
export function escapeLike(value: string): string {
  return String(value ?? '').replace(/[\\%_]/g, (match) => `\\${match}`)
}
