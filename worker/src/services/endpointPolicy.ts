export type EndpointValidationResult = { ok: true; url: string } | { ok: false; message: string }

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
])

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan']

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

/**
 * 尝试把 hostname 归一化为点分十进制 IPv4。
 *
 * 覆盖 S3/R2 兼容客户端常用的非十进制 IPv4 写法：
 * - 十进制整数：`https://2130706433/` → 127.0.0.1
 * - 十六进制整数：`https://0x7f000001/` → 127.0.0.1
 * - 十六进制分段：`0x7f.0.0.1`
 * - 八进制分段：`0177.0.0.1`
 *
 * 无法归一化为合法 32bit IPv4 时返回 null（按原样继续判断）。
 * 注：Workers runtime 无 DNS 解析能力，解析到私网 IP 的公网域名
 * 属已知边界，只能靠「endpoint 仅 admin 可配置」约束。
 */
function normalizeIpv4Hostname(hostname: string): string | null {
  // 纯整数形式（十进制或 0x 前缀十六进制）
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
    const value = hostname.toLowerCase().startsWith('0x')
      ? Number.parseInt(hostname, 16)
      : Number(hostname)
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
      '.'
    )
  }

  // 分段形式：任一段带 0x/0 前缀等非纯十进制写法时逐段解析
  if (hostname.includes('.')) {
    const parts = hostname.split('.')
    if (parts.length === 4) {
      const isNonDecimal = parts.some((part) => !/^\d+$/.test(part))
      if (isNonDecimal) {
        const nums = parts.map((part) => {
          if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part, 16)
          if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8)
          return Number.NaN
        })
        if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null
        return nums.join('.')
      }
    }
  }

  return null
}

function isPrivateIpv4(hostname: string): boolean {
  // 先归一化非十进制写法，防止整数/十六进制形式绕过黑名单
  const normalized = normalizeIpv4Hostname(hostname)
  return isPrivateIpv4Decimal(normalized ?? hostname)
}

function isPrivateIpv4Decimal(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false

  const nums = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN
    return Number(part)
  })
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return false

  const [a, b, c] = nums
  if (a === 0) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

function parseHextet(value: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) return null
  const parsed = Number.parseInt(value, 16)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : null
}

function ipv4FromHextets(high: number, low: number): string {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.')
}

function extractIpv4MappedAddress(hostname: string): string | null {
  const normalized = hostname.toLowerCase()
  const mappedPrefixes = ['::ffff:', '0:0:0:0:0:ffff:']
  const prefix = mappedPrefixes.find((candidate) => normalized.startsWith(candidate))
  if (!prefix) return null

  const tail = normalized.slice(prefix.length)
  if (tail.includes('.')) return tail

  const parts = tail.split(':')
  if (parts.length !== 2) return null

  const high = parseHextet(parts[0])
  const low = parseHextet(parts[1])
  if (high === null || low === null) return null

  return ipv4FromHextets(high, low)
}

function getFirstIpv6Hextet(hostname: string): number | null {
  const first = hostname.startsWith('::') ? '0' : hostname.split(':')[0]
  return parseHextet(first || '0')
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (!normalized.includes(':')) return false

  const mappedIpv4 = extractIpv4MappedAddress(normalized)
  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4)
  }

  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('2001:db8:') ||
    normalized === '2001:db8' ||
    normalized.startsWith('2001:2:') ||
    normalized === '2001:2'
  ) {
    return true
  }

  const first = getFirstIpv6Hextet(normalized)
  if (first === null) return true
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xff00) === 0xff00) return true

  return false
}

function isBlockedHostname(hostname: string): boolean {
  if (!hostname) return true
  if (BLOCKED_HOSTNAMES.has(hostname)) return true
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true
  if (isPrivateIpv4(hostname)) return true
  if (isBlockedIpv6(hostname)) return true
  return false
}

export function validateExternalEndpoint(endpoint: unknown): EndpointValidationResult {
  const raw = String(endpoint || '').trim()
  if (!raw) {
    return { ok: false, message: 'endpoint 不能为空' }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: 'endpoint 不是合法 URL' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, message: 'endpoint 必须使用 https' }
  }

  const hostname = normalizeHostname(url.hostname)
  if (isBlockedHostname(hostname)) {
    return { ok: false, message: 'endpoint 不能指向本机、内网或保留地址' }
  }

  return { ok: true, url: url.toString().replace(/\/$/, '') }
}
