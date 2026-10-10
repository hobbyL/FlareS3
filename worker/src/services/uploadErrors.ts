import { jsonResponse } from '../utils/response'
import { isRequestBodyPolicyError } from './requestBodyPolicy'
import { summarizeS3Error } from './r2'

export type UploadErrorDetails = Record<string, unknown>

export type UploadErrorShape = {
  status: number
  code: string
  message: string
  details?: UploadErrorDetails
}

type UploadErrorInput = Omit<UploadErrorShape, 'details'> & {
  details?: UploadErrorDetails
}

export class UploadRouteError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: UploadErrorDetails

  constructor({ status, code, message, details }: UploadErrorInput) {
    super(message)
    this.name = 'UploadRouteError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function isUploadRouteError(error: unknown): error is UploadRouteError {
  return error instanceof UploadRouteError
}

export function createUploadError(input: UploadErrorInput): UploadRouteError {
  return new UploadRouteError(input)
}

export function uploadErrorResponse(error: UploadErrorShape): Response {
  const body = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  }

  return jsonResponse(body, error.status)
}

export function invalidUploadRequestError(details?: UploadErrorDetails): UploadRouteError {
  return createUploadError({
    status: 400,
    code: 'UPLOAD_INVALID_REQUEST',
    message: '无效的请求',
    details,
  })
}

export function fileTooLargeError(declaredSize: number, maxFileSize: number): UploadRouteError {
  return createUploadError({
    status: 413,
    code: 'UPLOAD_FILE_TOO_LARGE',
    message: '文件大小超过限制',
    details: {
      declaredSize,
      maxFileSize,
    },
  })
}

export function userQuotaExceededError(
  declaredSize: number,
  quotaBytes: number,
  usedSpace: number
): UploadRouteError {
  return createUploadError({
    status: 413,
    code: 'UPLOAD_USER_QUOTA_EXCEEDED',
    message: '超出配额',
    details: {
      declaredSize,
      quotaBytes,
      usedSpace,
    },
  })
}

export function uploadConfigForbiddenError(message: string): UploadRouteError {
  return createUploadError({
    status: 403,
    code: 'UPLOAD_CONFIG_FORBIDDEN',
    message,
  })
}

export function uploadConfigNotFoundError(
  message: string = '配置不存在或不可用'
): UploadRouteError {
  return createUploadError({
    status: 404,
    code: 'UPLOAD_CONFIG_NOT_FOUND',
    message,
  })
}

export function uploadConfigUnavailableError(message: string = 'R2 未配置'): UploadRouteError {
  return createUploadError({
    status: 503,
    code: 'UPLOAD_CONFIG_UNAVAILABLE',
    message,
  })
}

export function uploadConfigCapacityExceededError(
  message: string = '所选存储配置空间不足'
): UploadRouteError {
  return createUploadError({
    status: 413,
    code: 'UPLOAD_CONFIG_CAPACITY_EXCEEDED',
    message,
  })
}

export function uploadFileNotFoundError(message: string = '文件不存在'): UploadRouteError {
  return createUploadError({
    status: 404,
    code: 'UPLOAD_FILE_NOT_FOUND',
    message,
  })
}

export function uploadFileExpiredError(message: string = '文件已过期'): UploadRouteError {
  return createUploadError({
    status: 410,
    code: 'UPLOAD_FILE_EXPIRED',
    message,
  })
}

export function confirmUploadNotPendingError(): UploadRouteError {
  return createUploadError({
    status: 409,
    code: 'UPLOAD_CONFIRM_NOT_PENDING',
    message: '文件不在待确认状态，无法完成确认',
  })
}

export function customShortCodeInvalidError(
  message: string = '自定义短码格式不正确'
): UploadRouteError {
  return createUploadError({
    status: 400,
    code: 'UPLOAD_CUSTOM_SHORT_CODE_INVALID',
    message,
  })
}

export function customShortCodeConflictError(
  message: string = '该自定义短码已被占用，请更换后重试'
): UploadRouteError {
  return createUploadError({
    status: 409,
    code: 'UPLOAD_CUSTOM_SHORT_CODE_CONFLICT',
    message,
  })
}

export function multipartNotInitializedError(): UploadRouteError {
  return createUploadError({
    status: 400,
    code: 'UPLOAD_MULTIPART_NOT_INITIALIZED',
    message: '分片上传未初始化',
  })
}

export function multipartUploadIdMissingError(): UploadRouteError {
  return createUploadError({
    status: 400,
    code: 'UPLOAD_MULTIPART_UPLOAD_ID_MISSING',
    message: 'upload_id 缺失',
  })
}

export function multipartUploadIdMismatchError(): UploadRouteError {
  return createUploadError({
    status: 400,
    code: 'UPLOAD_MULTIPART_UPLOAD_ID_MISMATCH',
    message: 'upload_id 不匹配',
  })
}

export function multipartPartNumberInvalidError(): UploadRouteError {
  return createUploadError({
    status: 400,
    code: 'UPLOAD_MULTIPART_PART_NUMBER_INVALID',
    message: 'part_number 无效',
  })
}

export function multipartSessionMissingError(): UploadRouteError {
  return createUploadError({
    status: 409,
    code: 'UPLOAD_MULTIPART_SESSION_MISSING',
    message: '分片上传会话不存在或已失效，请重新上传',
  })
}

export function multipartFileIdRequiredError(): UploadRouteError {
  return createUploadError({
    status: 400,
    code: 'UPLOAD_FILE_ID_REQUIRED',
    message: 'file_id 不能为空',
  })
}

export function uploadObjectMissingError(): UploadRouteError {
  return createUploadError({
    status: 409,
    code: 'UPLOAD_OBJECT_MISSING',
    message: '上传对象不存在或尚未完成',
  })
}

export function uploadObjectSizeInvalidError(): UploadRouteError {
  return createUploadError({
    status: 502,
    code: 'UPLOAD_OBJECT_SIZE_INVALID',
    message: '上传对象大小无效',
  })
}

export function uploadObjectSizeMismatchError(): UploadRouteError {
  return createUploadError({
    status: 409,
    code: 'UPLOAD_OBJECT_SIZE_MISMATCH',
    message: '上传对象大小与声明大小不一致',
  })
}

export function mapUnexpectedUploadError(
  error: unknown,
  fallback: {
    code: string
    message: string
    status?: number
  }
): UploadRouteError {
  if (isUploadRouteError(error)) {
    return error
  }

  // 自定义短码落库竞态冲突：统一映射为 409（与路由层预检文案一致）
  if (error instanceof Error && error.message === 'create_file_record_short_code_conflict') {
    return customShortCodeConflictError()
  }

  if (error instanceof SyntaxError || (error instanceof Error && error.message === 'empty_body')) {
    return invalidUploadRequestError()
  }

  if (isRequestBodyPolicyError(error)) {
    return createUploadError({
      status: error.status,
      code: 'UPLOAD_REQUEST_BODY_INVALID',
      message: error.message,
    })
  }

  const summary = summarizeS3Error(error)
  if (summary.code === 'NoSuchUpload') {
    return multipartSessionMissingError()
  }
  if (summary.code === 'NoSuchKey') {
    return uploadObjectMissingError()
  }
  if (summary.code === 'EntityTooSmall') {
    return createUploadError({
      status: 409,
      code: 'UPLOAD_MULTIPART_PARTS_INVALID',
      message: '分片数据不完整，请重新上传',
    })
  }
  if (summary.code || summary.httpStatusCode) {
    return createUploadError({
      status: 502,
      code: 'UPLOAD_STORAGE_REQUEST_FAILED',
      message: summary.message || '存储服务请求失败',
      details: {
        upstreamCode: summary.code,
        upstreamStatus: summary.httpStatusCode,
      },
    })
  }

  return createUploadError({
    status: fallback.status || 500,
    code: fallback.code,
    message: fallback.message,
  })
}
