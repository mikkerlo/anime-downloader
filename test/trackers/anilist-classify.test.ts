// AniList's classification table (#689). #703 (T7) extends it against
// captured fixtures.
import { describe, it, expect } from 'vitest'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { classifyAnilistError, graphqlErrorStatus } from '../../src/main/trackers/anilist/classify'

const api = (status: number, body = ''): TrackerApiError =>
  new TrackerApiError(`AniList API error: ${status}`, 'anilist', status, body)

const table = (rows: [string, () => unknown, TrackerErrorClass][]) =>
  rows.map(([name, make, cls]) => ({ name, make, cls }))

const gql = (status: number, message = 'x'): string =>
  JSON.stringify({ data: null, errors: [{ message, status }] })

describe('classifyAnilistError', () => {
  it.each(
    table([
      ['a bare TypeError', () => new TypeError('fetch failed'), 'network'],
      ['an ECONNRESET', () => ({ code: 'ECONNRESET' }), 'network'],
      ['HTTP 401', () => api(401, gql(401, 'Invalid token')), 'auth'],
      ['a 200 whose errors[0].status is 401', () => api(200, gql(401, 'Invalid token')), 'auth'],
      [
        'HTTP 403 (the API is down)',
        () => api(403, gql(403, 'temporarily disabled')),
        'rate-limit'
      ],
      ['HTTP 403 with no body', () => api(403), 'rate-limit'],
      ['HTTP 429', () => api(429, gql(429, 'Too Many Requests')), 'rate-limit'],
      ['HTTP 500', () => api(500, gql(500, 'Internal Server Error')), 'server'],
      ['HTTP 502 with no body', () => api(502), 'server'],
      ['a 200 whose errors[0].status is 500', () => api(200, gql(500)), 'server'],
      ['HTTP 400', () => api(400, gql(400, 'Validation')), 'item'],
      ['HTTP 404', () => api(404, gql(404, 'Not Found.')), 'item'],
      ['a 200 whose errors[0].status is 404', () => api(200, gql(404, 'Not Found.')), 'item'],
      [
        'a 200 whose errors carry no status',
        () => api(200, '{"errors":[{"message":"x"}]}'),
        'item'
      ],
      ['a plain Error', () => new Error('logic bug'), 'item']
    ])
  )('$name → $cls', ({ make, cls }) => {
    expect(classifyAnilistError(make())).toBe(cls)
  })

  it('a 403 is rate-limit, not server or auth', () => {
    const cls = classifyAnilistError(api(403))
    expect(cls).toBe('rate-limit')
    expect(cls).not.toBe('server')
    expect(cls).not.toBe('auth')
  })

  it('a TrackerApiError with a network code in its cause is classified by status', () => {
    const err = new TrackerApiError('x', 'anilist', 500, '', { cause: { code: 'ECONNRESET' } })
    expect(classifyAnilistError(err)).toBe('server')
  })
})

describe('graphqlErrorStatus', () => {
  it('reads errors[0].status, and survives a truncated body', () => {
    expect(graphqlErrorStatus(gql(401))).toBe(401)
    expect(graphqlErrorStatus(gql(401).slice(0, -3))).toBe(401)
    expect(graphqlErrorStatus('{"data":{}}')).toBeNull()
    expect(graphqlErrorStatus('')).toBeNull()
    expect(graphqlErrorStatus('<html>')).toBeNull()
  })
})
