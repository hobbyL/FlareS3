export function formatDateTimeLocal(isoString: string | null): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  const time = date.getTime()
  if (Number.isNaN(time)) return ''

  const pad = (n: number) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  return `${y}-${m}-${d} ${hh}:${mm}`
}
