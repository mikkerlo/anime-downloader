// MyAnimeList's classification table (#689). #702 (T6) extends it against
// captured fixtures.
import { describe, it, expect } from 'vitest'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { classifyMalError } from '../../src/main/trackers/mal/classify'

const table = (rows: [string, () => unknown, TrackerErrorClass][]) =>
  rows.map(([name, make, cls]) => ({ name, make, cls }))

const api = (status: number, body = ''): TrackerApiError =>
  new TrackerApiError(`MAL API error: ${status}`, 'mal', status, body)

describe('classifyMalError', () => {
  it.each(
    table([
      ['a bare TypeError', () => new TypeError('fetch failed'), 'network'],
      ['an ETIMEDOUT', () => ({ code: 'ETIMEDOUT' }), 'network'],
      ['400 "Invalid client id"', () => api(400, '{"message":"Invalid client id"}'), 'config'],
      ['invalid_client on refresh', () => api(401, '{"error":"invalid_client"}'), 'config'],
      ['403 forbidden', () => api(403, '{"error":"forbidden"}'), 'config'],
      ['403 with an unrecognised body', () => api(403, '<html>nope</html>'), 'config'],
      ['403 with no body', () => api(403), 'config'],
      ['403 "DoS detected"', () => api(403, '<html>DoS detected</html>'), 'rate-limit'],
      ['401 invalid_token', () => api(401, '{"error":"invalid_token"}'), 'auth'],
      ['500', () => api(500), 'server'],
      ['504', () => api(504, '<html>Gateway Timeout</html>'), 'server'],
      ['400 other', () => api(400, '{"error":"invalid_parameters"}'), 'item'],
      ['404', () => api(404, '{"error":"not_found"}'), 'item'],
      ['a plain Error', () => new Error('logic bug'), 'item']
    ])
  )('$name → $cls', ({ make, cls }) => {
    expect(classifyMalError(make())).toBe(cls)
  })
})
