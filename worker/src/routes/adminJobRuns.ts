import type { Env } from '../config/env'
import { listJobRuns } from '../services/jobRuns'
import { jsonResponse } from './utils'

/**
 * 获取管理员任务运行记录列表
 *
 * @route GET /api/admin/job-runs
 * @param request - HTTP 请求对象（需要管理员权限）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含任务运行记录列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20）
 *
 * // 成功响应 (200)
 * {
 *   "total": 100,
 *   "page": 1,
 *   "limit": 20,
 *   "items": [
 *     {
 *       "id": "uuid",
 *       "job_name": "cleanup",
 *       "status": "success",
 *       "started_at": "2026-09-14T00:00:00.000Z",
 *       "completed_at": "2026-09-14T00:05:00.000Z",
 *       "error_message": null
 *     }
 *   ]
 * }
 */
export async function listAdminJobRuns(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const page = Number(url.searchParams.get('page') || 1)
  const limit = Number(url.searchParams.get('limit') || 20)
  return jsonResponse(await listJobRuns(env.DB, { page, limit }))
}
