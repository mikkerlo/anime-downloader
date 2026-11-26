// `STORE_DEFAULTS` moved out of `src/main/index.ts` into `store/defaults.ts`
// (#689). The dump was taken on the pre-move commit by evaluating the literal
// cut from `src/main/index.ts`, so this pins the move as value-neutral, and any
// later default change or unlisted new key as a deliberate edit.
import { describe, it, expect } from 'vitest'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { PERSISTED_STORE_KEYS } from '../../src/main/store/keys'
import dump from '../fixtures/store-defaults-6.0.21.json'
import { GOLDEN_NEW_KEYS } from '../helpers/golden-allow-list'

const defaults = STORE_DEFAULTS as Record<string, unknown>
const frozen = dump as Record<string, unknown>

describe('STORE_DEFAULTS against the 6.0.21 dump', () => {
  it('holds every 6.0.21 key at its 6.0.21 value', () => {
    for (const key of Object.keys(frozen)) {
      expect(defaults, key).toHaveProperty([key])
      expect(defaults[key], key).toStrictEqual(frozen[key])
    }
  })

  it('adds no key outside the dump except allow-listed ones, at their listed defaults', () => {
    const extra = Object.keys(defaults).filter((key) => !(key in frozen))
    expect(extra.filter((key) => !(key in GOLDEN_NEW_KEYS))).toEqual([])
    for (const key of extra) expect(defaults[key], key).toStrictEqual(GOLDEN_NEW_KEYS[key])
  })

  it('the dump plus the allow-list is the persisted key tuple', () => {
    const expected = [...Object.keys(frozen), ...Object.keys(GOLDEN_NEW_KEYS)].sort()
    expect([...PERSISTED_STORE_KEYS].sort()).toEqual(expected)
  })
})
