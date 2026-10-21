import bcrypt from 'bcryptjs'

const SALT_ROUNDS = 10
export const MAX_PASSWORD_BYTES = 72

export function isPasswordWithinByteLimit(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    new TextEncoder().encode(password).byteLength <= MAX_PASSWORD_BYTES
  )
}

export function hashPassword(password: string): string {
  if (!isPasswordWithinByteLimit(password))
    throw new Error('密码必须为字符串且 UTF-8 长度不能超过 72 字节')
  return bcrypt.hashSync(password, SALT_ROUNDS)
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash)
}
