import type { Env } from './env'

export class EnvValidationError extends Error {
  constructor(
    public field: string,
    public reason: string
  ) {
    super(`环境变量验证失败: ${field} - ${reason}`)
    this.name = 'EnvValidationError'
  }
}

interface ValidationRule {
  field: keyof Env
  required?: boolean
  validate?: (value: unknown, env: Env) => string | null
}

const AUTH_TOKEN_SECRET_MIN_LENGTH = 32
const R2_MASTER_KEY_EXPECTED_LENGTH = 44 // 32 bytes base64

/** 限流阈值环境变量：全部可选，配置了就必须是正数 */
const RATE_LIMIT_NUMERIC_FIELDS = [
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_MAX_FAILED_ATTEMPTS',
  'RATE_LIMIT_BLOCK_DURATION_MS',
  'SHARE_RATE_LIMIT_MAX_FAILED_ATTEMPTS',
  'SHARE_RATE_LIMIT_BLOCK_DURATION_MS',
  'PUBLIC_RATE_LIMIT_WINDOW_MS',
  'PUBLIC_RATE_LIMIT_MAX',
] as const satisfies readonly (keyof Env)[]

const validationRules: ValidationRule[] = [
  {
    field: 'DB',
    required: true,
    validate: (value) => {
      if (!value || typeof value !== 'object') {
        return 'DB 绑定缺失或无效'
      }
      return null
    },
  },
  {
    field: 'AUTH_TOKEN_SECRET',
    required: true,
    validate: (value) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return 'AUTH_TOKEN_SECRET 必须是非空字符串'
      }
      if (value.length < AUTH_TOKEN_SECRET_MIN_LENGTH) {
        return `AUTH_TOKEN_SECRET 长度至少为 ${AUTH_TOKEN_SECRET_MIN_LENGTH} 字符（当前: ${value.length}）`
      }
      return null
    },
  },
  {
    field: 'R2_MASTER_KEY',
    required: true,
    validate: (value) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return 'R2_MASTER_KEY 必须是非空字符串'
      }
      if (value.length !== R2_MASTER_KEY_EXPECTED_LENGTH) {
        return `R2_MASTER_KEY 应为 32 字节 base64 编码（预期长度: ${R2_MASTER_KEY_EXPECTED_LENGTH}，当前: ${value.length}）`
      }
      // 验证是否为有效的 base64
      try {
        const decoded = atob(value)
        if (decoded.length !== 32) {
          return `R2_MASTER_KEY 解码后应为 32 字节（当前: ${decoded.length}）`
        }
      } catch {
        return 'R2_MASTER_KEY 不是有效的 base64 编码'
      }
      return null
    },
  },
  {
    field: 'MAX_FILE_SIZE',
    required: false,
    validate: (value) => {
      if (value === undefined || value === null || value === '') return null
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) {
        return 'MAX_FILE_SIZE 必须是正数'
      }
      return null
    },
  },
  {
    field: 'TOTAL_STORAGE',
    required: false,
    validate: (value) => {
      if (value === undefined || value === null || value === '') return null
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) {
        return 'TOTAL_STORAGE 必须是正数'
      }
      return null
    },
  },
  ...RATE_LIMIT_NUMERIC_FIELDS.map(
    (field): ValidationRule => ({
      field,
      required: false,
      validate: (value) => {
        if (value === undefined || value === null || value === '') return null
        const num = Number(value)
        if (!Number.isFinite(num) || num <= 0) {
          return `${field} 必须是正数`
        }
        return null
      },
    })
  ),
]

export function validateEnv(env: Env): void {
  const errors: EnvValidationError[] = []

  for (const rule of validationRules) {
    const value = env[rule.field]

    if (rule.required && (value === undefined || value === null)) {
      errors.push(new EnvValidationError(String(rule.field), '必填字段缺失'))
      continue
    }

    if (rule.validate) {
      const error = rule.validate(value, env)
      if (error) {
        errors.push(new EnvValidationError(String(rule.field), error))
      }
    }
  }

  if (errors.length > 0) {
    const message = ['环境变量验证失败:', ...errors.map((e) => `  - ${e.field}: ${e.reason}`)].join(
      '\n'
    )
    throw new Error(message)
  }
}

export function validateEnvOrWarn(env: Env): boolean {
  try {
    validateEnv(env)
    return true
  } catch (error) {
    console.error('[EnvValidation]', error instanceof Error ? error.message : String(error))
    return false
  }
}
