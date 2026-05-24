import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { resolve, join } from 'path'

/**
 * Anonymization gate for committed test fixtures (Phase 7 PR 2, slice 7b.2).
 *
 * Captured API responses get committed under `test/fixtures/`. They must not
 * leak real bearer tokens, OAuth refresh tokens, or anything that pattern-
 * matches an authentication secret. Fake stand-ins (e.g.
 * "fake-access-token-replaced") are explicitly allowed.
 */
const FIXTURES_ROOT = resolve(__dirname, 'fixtures')

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, files)
    else files.push(full)
  }
  return files
}

const ALLOWED_FAKE_TOKEN = /fake-(access|refresh)-token/i

// Patterns that strongly suggest a real credential. The grep is intentionally
// conservative — false positives mean an extra round-trip with the author, not
// a missed leak.
const SUSPECT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Bearer followed by a non-trivial token value
  { name: 'Bearer auth header', re: /Bearer\s+[A-Za-z0-9._-]{16,}/ },
  // Long base64-ish token values associated with access_token / refresh_token
  // (but tolerate the explicit fake placeholders).
  {
    name: 'access_token literal',
    re: /"access_token"\s*:\s*"(?!fake-)[A-Za-z0-9._-]{20,}"/
  },
  {
    name: 'refresh_token literal',
    re: /"refresh_token"\s*:\s*"(?!fake-)[A-Za-z0-9._-]{20,}"/
  }
]

describe('test fixtures — anonymization gate', () => {
  it('contains no real-looking access/refresh tokens or Bearer auth headers', () => {
    const findings: string[] = []
    for (const file of walk(FIXTURES_ROOT)) {
      if (!file.endsWith('.json') && !file.endsWith('.md')) continue
      const content = readFileSync(file, 'utf8')
      for (const { name, re } of SUSPECT_PATTERNS) {
        const m = content.match(re)
        if (m && !ALLOWED_FAKE_TOKEN.test(m[0])) {
          findings.push(`${file}: ${name} → ${m[0].slice(0, 60)}`)
        }
      }
    }
    expect(findings).toEqual([])
  })
})
