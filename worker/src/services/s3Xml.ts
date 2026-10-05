export type NormalizedMultipartPart = {
  partNumber: number
  etag: string
}

export function extractXmlValue(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`))
  return match?.[1] ? String(match[1]) : null
}

export function extractXmlBlocks(xml: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g')
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[1] ?? '')
  }
  return blocks
}

export function decodeXmlEntities(value: string): string {
  const input = String(value ?? '')
  if (!input.includes('&')) return input

  let output = input
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')

  output = output.replace(/&#(x?[0-9a-fA-F]+);/g, (match, code) => {
    const raw = String(code || '')
    const num =
      raw.startsWith('x') || raw.startsWith('X')
        ? Number.parseInt(raw.slice(1), 16)
        : Number.parseInt(raw, 10)
    if (!Number.isFinite(num)) return match
    try {
      return String.fromCodePoint(num)
    } catch {
      return match
    }
  })

  output = output.replaceAll('&amp;', '&')
  return output
}

export function encodeXmlEntities(value: string): string {
  const input = String(value ?? '')
  if (!/[&<>"']/.test(input)) return input

  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function parseListPartsXml(xml: string): Array<{ PartNumber: number; ETag?: string }> {
  return extractXmlBlocks(xml, 'Part')
    .map((block) => {
      const partNumber = Number(extractXmlValue(block, 'PartNumber'))
      const etagRaw = extractXmlValue(block, 'ETag')
      const etag = etagRaw ? decodeXmlEntities(etagRaw) : undefined
      return { PartNumber: partNumber, ETag: etag }
    })
    .filter((part) => Number.isFinite(part.PartNumber) && Number(part.PartNumber) > 0)
}

export function normalizeCompleteMultipartParts(
  parts: { PartNumber?: number; ETag?: string }[]
): NormalizedMultipartPart[] {
  return (parts || [])
    .map((part) => ({
      partNumber: Number(part.PartNumber),
      etag: typeof part.ETag === 'string' ? part.ETag : '',
    }))
    .filter((part) => Number.isFinite(part.partNumber) && part.partNumber > 0 && part.etag)
    .sort((a, b) => a.partNumber - b.partNumber)
}

export function buildCompleteMultipartUploadXml(parts: NormalizedMultipartPart[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CompleteMultipartUpload>` +
    parts
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${encodeXmlEntities(
            part.etag
          )}</ETag></Part>`
      )
      .join('') +
    `</CompleteMultipartUpload>`
  )
}

/**
 * 生成 S3 DeleteObjects（POST ?delete）请求体。
 *
 * Quiet 模式下响应只包含失败对象，避免大批量删除时响应体膨胀；
 * Key 必须经 encodeXmlEntities 转义（与解析方向的 decodeXmlEntities 对称）。
 */
export function buildDeleteObjectsXml(keys: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Delete>` +
    keys.map((key) => `<Object><Key>${encodeXmlEntities(key)}</Key></Object>`).join('') +
    `<Quiet>true</Quiet>` +
    `</Delete>`
  )
}

export type DeleteObjectsErrorItem = {
  key: string
  code?: string
  message?: string
}

/**
 * 解析 DeleteObjects Quiet 模式响应中的失败对象列表。
 *
 * Quiet 模式仅返回 <Error> 块（成功对象不返回 <Deleted> 块）；
 * 字段值经 decodeXmlEntities 还原字面量。
 */
export function parseDeleteObjectsResultXml(xml: string): DeleteObjectsErrorItem[] {
  return extractXmlBlocks(xml, 'Error')
    .map((block) => {
      const keyRaw = extractXmlValue(block, 'Key')
      const codeRaw = extractXmlValue(block, 'Code')
      const messageRaw = extractXmlValue(block, 'Message')

      const item: DeleteObjectsErrorItem = {
        key: keyRaw ? decodeXmlEntities(keyRaw) : '',
      }
      if (codeRaw) item.code = decodeXmlEntities(codeRaw)
      if (messageRaw) item.message = decodeXmlEntities(messageRaw)
      return item
    })
    .filter((item) => item.key)
}
