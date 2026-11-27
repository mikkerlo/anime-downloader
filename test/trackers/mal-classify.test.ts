// MyAnimeList's classification table (#689), extended by #702 (T6): one row
// per line of the #702 § 4 table, on the bodies under `test/fixtures/mal/`.
import { describe, it, expect } from 'vitest'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { classifyMalError } from '../../src/main/trackers/mal/classify'
import {
  MalConfigError,
  MalSessionChangedError,
  MalSessionGoneError
} from '../../src/main/trackers/mal/errors'
import { OfflineError } from '../../src/main/lib/net'
import { malFixtureText } from '../helpers/fake-mal'

const table = (rows: [string, () => unknown, TrackerErrorClass][]) =>
  rows.map(([name, make, cls]) => ({ name, make, cls }))

const api = (status: number, body = ''): TrackerApiError =>
  new TrackerApiError(`MAL API error: ${status}`, 'mal', status, body)

describe('classifyMalError', () => {
  it.each(
    table([
      ['a bare TypeError', () => new TypeError('fetch failed'), 'network'],
      ['an ETIMEDOUT', () => ({ code: 'ETIMEDOUT' }), 'network'],
      ['an OfflineError', () => new OfflineError(), 'network'],
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

// #702 § 4, row by row, on the fixture bodies.
describe('classifyMalError: the #702 table', () => {
  it.each(
    table([
      [
        '400 "Invalid client id" (fixture)',
        () => api(400, malFixtureText('error-invalid-client-id.json')),
        'config'
      ],
      ['403 forbidden (fixture)', () => api(403, malFixtureText('error-forbidden.json')), 'config'],
      [
        '403 "DoS detected" (fixture)',
        () => api(403, malFixtureText('error-dos-detected.html')),
        'rate-limit'
      ],
      // Red on main: a 429 fell through to `item` and dropped the queue entry.
      ['429', () => api(429), 'rate-limit'],
      ['429 with a body', () => api(429, '<html>Too Many Requests</html>'), 'rate-limit'],
      [
        '401 invalid_token (fixture)',
        () => api(401, malFixtureText('error-invalid-token.json')),
        'auth'
      ],
      // Red on main: `invalid_grant` on a 400 was `item`.
      [
        'refresh → invalid_grant (fixture)',
        () => api(400, malFixtureText('error-invalid-grant.json')),
        'auth'
      ],
      [
        'the refresh’s session-expired error',
        () => new MalSessionGoneError('MyAnimeList session expired'),
        'auth'
      ],
      [
        'code exchange → invalid_grant (fixture)',
        () => api(400, malFixtureText('error-invalid-grant.json')),
        'auth'
      ],
      [
        'refresh → invalid_client (fixture)',
        () => api(401, malFixtureText('error-invalid-client.json')),
        'config'
      ],
      ['no client ID saved', () => new MalConfigError('no client ID'), 'config'],
      ['the account changed during the token read', () => new MalSessionChangedError(), 'network'],
      ['502', () => api(502), 'server'],
      [
        '404 unknown anime (fixture)',
        () => api(404, malFixtureText('error-not-found.json')),
        'item'
      ]
    ])
  )('$name → $cls', ({ make, cls }) => {
    expect(classifyMalError(make())).toBe(cls)
  })
})
