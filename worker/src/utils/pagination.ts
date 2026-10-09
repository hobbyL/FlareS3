/**
 * 分页查询参数守卫。
 *
 * 非数字（如 ?page=abc）经 Number() 会得到 NaN，直接绑进 SQL 会触发
 * SQLITE_MISMATCH 导致路由 500；这里统一 NaN → fallback、超界 → clamp、
 * 非整数 → floor，行为与 routes/shares.ts 原有的 normalizePositiveInt 一致。
 */

// page 上限取 1e9：offset = (page-1)*limit ≤ 1e9 * 100 = 1e11，仍在安全整数范围内，
// 避免极端大数溢出 offset 后产生非预期的负/NaN 偏移
export const MAX_PAGE_VALUE = 1_000_000_000
export const DEFAULT_PAGE_VALUE = 1
export const DEFAULT_LIMIT_VALUE = 20
export const MAX_LIMIT_VALUE = 100

export function normalizePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

/** 解析 page 查询参数（NaN → 1，超界 clamp 到 MAX_PAGE_VALUE） */
export function normalizePageParam(value: string | null): number {
  return normalizePositiveInt(value, DEFAULT_PAGE_VALUE, MAX_PAGE_VALUE)
}

/** 解析 limit 查询参数（NaN → 20，范围 [1, 100]） */
export function normalizeLimitParam(value: string | null): number {
  return normalizePositiveInt(value, DEFAULT_LIMIT_VALUE, MAX_LIMIT_VALUE)
}
