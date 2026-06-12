export type UploadedObjectSizeValidationResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID_ACTUAL_SIZE' | 'SIZE_MISMATCH' }

export const MAX_S3_MULTIPART_PARTS = 10_000

export function normalizeDeclaredFileSize(value: unknown): number | null {
  const size = Number(value)
  if (!Number.isFinite(size) || !Number.isInteger(size) || size <= 0) {
    return null
  }
  return size
}

export function calculateMultipartTotalParts(fileSize: unknown, partSize: unknown): number | null {
  const normalizedFileSize = normalizeDeclaredFileSize(fileSize)
  const normalizedPartSize = normalizeDeclaredFileSize(partSize)
  if (normalizedFileSize === null || normalizedPartSize === null) {
    return null
  }
  return Math.ceil(normalizedFileSize / normalizedPartSize)
}

export function normalizeMultipartPartNumber(
  value: unknown,
  maxPartNumber: number = MAX_S3_MULTIPART_PARTS
): number | null {
  const partNumber = Number(value)
  if (
    !Number.isFinite(partNumber) ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > MAX_S3_MULTIPART_PARTS
  ) {
    return null
  }

  if (
    !Number.isFinite(maxPartNumber) ||
    !Number.isInteger(maxPartNumber) ||
    maxPartNumber < 1 ||
    partNumber > maxPartNumber
  ) {
    return null
  }

  return partNumber
}

export function validateUploadedObjectSize(
  expectedSize: number,
  actualSize: number
): UploadedObjectSizeValidationResult {
  if (!Number.isFinite(actualSize) || !Number.isInteger(actualSize) || actualSize < 0) {
    return { ok: false, reason: 'INVALID_ACTUAL_SIZE' }
  }

  if (actualSize !== expectedSize) {
    return { ok: false, reason: 'SIZE_MISMATCH' }
  }

  return { ok: true }
}
