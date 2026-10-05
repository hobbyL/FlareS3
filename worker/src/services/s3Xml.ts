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
