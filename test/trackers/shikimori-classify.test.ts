// Shikimori's classification table (#689): the 6.x drain's branches, in their
// order (the generic drain applies the class, `services/trackers/sync.ts:521-569`),
// with `ShikiAuthError` checked by class ahead of the status rows.
import { describe, it, expect } from 'vitest'
import { ShikiApiError, ShikiAuthError } from '../../src/main/shikimori'
import { OfflineError } from '../../src/main/lib/net'
import { classifyShikimoriError } from '../../src/main/trackers/shikimori.errors'

const table = (rows: [string, () => unknown, TrackerErrorClass][]) =>
  rows.map(([name, make, cls]) => ({ name, make, cls }))

const withCause = <E extends Error>(err: E, code: string): E =>
  Object.assign(err, { cause: { code } })

const timeout = (): Error => Object.assign(new Error('timed out'), { name: 'TimeoutError' })

describe('classifyShikimoriError', () => {
  it.each(
    table([
      // 1. network
      ['a bare TypeError', () => new TypeError('fetch failed'), 'network'],
      ['a timeout', timeout, 'network'],
      ['an ECONNRESET', () => ({ code: 'ECONNRESET' }), 'network'],
      ['the offline gate', () => new OfflineError(), 'network'],
      // 2. ShikiAuthError, whatever its status
      ['ShikiAuthError 401', () => new ShikiAuthError('expired'), 'auth'],
      ['ShikiAuthError 400 (invalid_grant)', () => new ShikiAuthError('expired', 400), 'auth'],
      ['ShikiAuthError 403', () => new ShikiAuthError('expired', 403), 'auth'],
      // 3. auth
      ['ShikiApiError 401', () => new ShikiApiError('unauthorized', 401), 'auth'],
      ['ShikiApiError 403', () => new ShikiApiError('forbidden', 403), 'auth'],
      // 4. rate-limit
      ['ShikiApiError 429', () => new ShikiApiError('slow down', 429), 'rate-limit'],
      // 5. server
      ['ShikiApiError 500', () => new ShikiApiError('boom', 500), 'server'],
      ['ShikiApiError 503', () => new ShikiApiError('down', 503), 'server'],
      ['ShikiApiError 599', () => new ShikiApiError('edge', 599), 'server'],
      // 6. item
      ['ShikiApiError 400', () => new ShikiApiError('bad request', 400), 'item'],
      ['ShikiApiError 404', () => new ShikiApiError('not found', 404), 'item'],
      ['ShikiApiError 422', () => new ShikiApiError('invalid', 422), 'item'],
      ['ShikiApiError 600', () => new ShikiApiError('odd', 600), 'item'],
      ['a plain Error', () => new Error('logic bug'), 'item'],
      ['a string', () => 'boom', 'item']
    ])
  )('$name → $cls', ({ make, cls }) => {
    expect(classifyShikimoriError(make())).toBe(cls)
  })

  describe('the check order', () => {
    it('a ShikiApiError(500) whose cause carries ECONNRESET is server, not network', () => {
      expect(classifyShikimoriError(withCause(new ShikiApiError('boom', 500), 'ECONNRESET'))).toBe(
        'server'
      )
    })

    it('a ShikiApiError(404) whose cause carries ECONNRESET is item, not network', () => {
      expect(
        classifyShikimoriError(withCause(new ShikiApiError('not found', 404), 'ECONNRESET'))
      ).toBe('item')
    })

    it('a 400 is decided by the class, not the status', () => {
      expect(classifyShikimoriError(new ShikiAuthError('expired', 400))).toBe('auth')
      expect(classifyShikimoriError(new ShikiApiError('bad request', 400))).toBe('item')
    })

    it('never returns config', () => {
      const all = [400, 401, 403, 404, 429, 500, 503].flatMap((s) => [
        new ShikiApiError('x', s),
        new ShikiAuthError('x', s)
      ])
      for (const err of all) expect(classifyShikimoriError(err)).not.toBe('config')
    })
  })
})
