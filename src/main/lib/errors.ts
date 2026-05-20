import * as shikimori from '../shikimori'

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
])

export function errorCode(err: unknown): string | undefined {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code
  }
  if (err && typeof err === 'object' && 'cause' in err) {
    return errorCode((err as { cause: unknown }).cause)
  }
  return undefined
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof shikimori.ShikiApiError) return false
  if (err instanceof TypeError) return true
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
    return true
  const code = errorCode(err)
  if (code && NETWORK_ERROR_CODES.has(code)) return true
  return false
}
