import { describe, it, expect } from 'vitest'
import { errorCode, isNetworkError } from '../../src/main/lib/errors'
import { ShikiApiError } from '../../src/main/shikimori'

describe('errorCode', () => {
  it('reads a string code off the error', () => {
    expect(errorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET')
  })

  it('walks into the cause chain', () => {
    expect(errorCode({ cause: { cause: { code: 'ENOTFOUND' } } })).toBe('ENOTFOUND')
  })

  it('returns undefined when no code is present', () => {
    expect(errorCode(new Error('boom'))).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
    expect(errorCode('string')).toBeUndefined()
    expect(errorCode({ code: 42 })).toBeUndefined()
  })
})

describe('isNetworkError', () => {
  it('treats a ShikiApiError as a non-network (application) error', () => {
    expect(isNetworkError(new ShikiApiError('server error', 500))).toBe(false)
  })

  it('treats a bare TypeError (fetch failure) as a network error', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('treats AbortError / TimeoutError as network errors', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    expect(isNetworkError(abort)).toBe(true)
    expect(isNetworkError(timeout)).toBe(true)
  })

  it('treats known network error codes as network errors', () => {
    for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_SOCKET']) {
      expect(isNetworkError({ code })).toBe(true)
    }
  })

  it('does not treat unknown codes or plain errors as network errors', () => {
    expect(isNetworkError({ code: 'EACCES' })).toBe(false)
    expect(isNetworkError(new Error('logic bug'))).toBe(false)
    expect(isNetworkError(null)).toBe(false)
  })
})
