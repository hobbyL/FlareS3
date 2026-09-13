import type { Env } from '../config/env'
import { getAdminOverviewData } from '../services/adminOverview'
import { jsonResponse } from './utils'

/**
 * 获取管理员概览数据
 *
 * @route GET /api/admin/overview
 * @param _request - HTTP 请求对象（需要管理员权限）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含系统概览统计数据
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "users": {
 *     "total": 100,
 *     "active": 95,
 *     "suspended": 5
 *   },
 *   "files": {
 *     "total": 1000,
 *     "completed": 950,
 *     "deleted": 50
 *   },
 *   "storage": {
 *     "used": 10737418240,
 *     "total": 107374182400,
 *     "usedFormatted": "10.00 GB",
 *     "totalFormatted": "100.00 GB",
 *     "usagePercent": 10
 *   },
 *   "shares": {
 *     "file_shares": 50,
 *     "text_shares": 30,
 *     "one_time_shares": 20
 *   }
 * }
 */
export async function getAdminOverview(_request: Request, env: Env): Promise<Response> {
  return jsonResponse(await getAdminOverviewData(env))
}
