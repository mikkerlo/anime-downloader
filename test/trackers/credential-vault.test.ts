// The AniList / MyAnimeList credential vault (#690), against a fake
// safeStorage on both backends: the async pair Electron 45+ has, and the sync
// pair the locked 41.10.7 has.
import { describe, it, expect, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeSafeStorage, type FakeSafeStorage } from '../helpers/fake-safe-storage'
import {
  createCredentialVault,
  createSafeStorageHolder,
  VAULT_KEYS,
  VAULT_PLAIN_WARNING,
  type CredentialVault,
  type VaultBlob,
  type VaultKey
} from '../../src/main/trackers/credential-vault'

const KEY: VaultKey = 'anilistCredentials'
const TOKEN = { access_token: 'al-SECRET-token', expires_at: 1_900_000_000 }

interface Rig {
  vault: CredentialVault
  store: InMemoryStorage
  fake: FakeSafeStorage
  set: ReturnType<typeof vi.spyOn>
  warn: ReturnType<typeof vi.fn>
  onLocked: ReturnType<typeof vi.fn>
}

function rig(
  opts: { async?: boolean; available?: boolean; seed?: Record<string, unknown> } = {}
): Rig {
  const store = new InMemoryStorage({
    anilistCredentials: null,
    myanimelistCredentials: null,
    myanimelistClientSecret: null,
    ...opts.seed
  })
  const fake = createFakeSafeStorage({ async: opts.async, available: opts.available })
  const warn = vi.fn()
  const onLocked = vi.fn()
  const vault = createCredentialVault({ store, safeStorage: fake.holder, warn, onLocked })
  const set = vi.spyOn(store, 'set')
  return { vault, store, fake, set, warn, onLocked }
}

const bytes = (r: Rig, key: VaultKey = KEY): string => JSON.stringify(r.store.get(key))
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const BACKENDS = [
  ['async', true],
  ['sync', false]
] as const

describe.each(BACKENDS)('credential vault on the %s backend', (_name, isAsync) => {
  it('round-trips a value through safeStorage, with no plaintext in the stored blob', async () => {
    const r = rig({ async: isAsync })
    expect(await r.vault.write(KEY, TOKEN)).toBe(true)
    const blob = r.store.get(KEY) as VaultBlob
    expect(blob).toMatchObject({ v: 1, enc: 'safeStorage' })
    expect(Buffer.from(blob.data, 'base64').length).toBeGreaterThan(0)
    expect(bytes(r)).not.toContain('al-SECRET-token')
    expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
    expect(r.warn).not.toHaveBeenCalled()
  })

  it('falls back to plain storage with the warning when encryption is unavailable, and never calls setUsePlainTextEncryption', async () => {
    const r = rig({ async: isAsync, available: false })
    await r.vault.write(KEY, TOKEN)
    expect(r.store.get(KEY)).toEqual({ v: 1, enc: 'plain', data: JSON.stringify(TOKEN) })
    expect(r.warn).toHaveBeenCalledWith(expect.stringContaining(VAULT_PLAIN_WARNING))
    expect(VAULT_PLAIN_WARNING).toMatch(/config\.backup\.json until the next start/)
    expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'plain' })
    expect(r.fake.setUsePlainTextEncryption).not.toHaveBeenCalled()
    expect(r.fake.touched).not.toContain('setUsePlainTextEncryption')
  })

  it('an undecryptable blob reads as locked and stays byte-identical, also after a re-encrypt attempt and a fallback attempt', async () => {
    const r = rig({ async: isAsync })
    await r.vault.write(KEY, TOKEN)
    r.fake.key = 'another-user'
    const before = bytes(r)
    r.set.mockClear()

    expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
    expect(r.onLocked).toHaveBeenCalledWith(KEY)
    expect(bytes(r)).toBe(before)

    r.fake.shouldReEncrypt = true
    expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
    expect(bytes(r)).toBe(before)

    r.fake.available = false
    expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
    expect(bytes(r)).toBe(before)
    expect(r.set).not.toHaveBeenCalled()
    // Once per locked blob, not per read (review of #719): three reads of the
    // same bytes are one call. Mutation check: fire per read and this reds.
    expect(r.onLocked).toHaveBeenCalledTimes(1)
  })

  it('onLocked fires again for a new locked blob under the same key', async () => {
    const r = rig({ async: isAsync })
    await r.vault.write(KEY, TOKEN)
    r.fake.key = 'another-user'
    await r.vault.read(KEY)
    await r.vault.read(KEY)
    expect(r.onLocked).toHaveBeenCalledTimes(1)

    // A sign-in under keyring B, then B lost too: different bytes, locked again.
    r.fake.key = 'user-key-b'
    await r.vault.write(KEY, { access_token: 'other' })
    r.fake.key = 'another-user-c'
    expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
    await r.vault.read(KEY)
    expect(r.onLocked).toHaveBeenCalledTimes(2)
    expect(r.onLocked).toHaveBeenLastCalledWith(KEY)
  })

  it('a successful read in between resets it, so the same blob locking again fires again', async () => {
    const r = rig({ async: isAsync })
    await r.vault.write(KEY, TOKEN)
    r.fake.key = 'another-user'
    await r.vault.read(KEY)
    expect(r.onLocked).toHaveBeenCalledTimes(1)

    // The keyring comes back: the same bytes decrypt.
    r.fake.key = 'user-key'
    expect(await r.vault.read(KEY)).toMatchObject({ state: 'ok', value: TOKEN })
    r.fake.key = 'another-user'
    expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
    expect(r.onLocked).toHaveBeenCalledTimes(2)
  })

  it('keys are tracked separately', async () => {
    const r = rig({ async: isAsync })
    await r.vault.write(KEY, TOKEN)
    await r.vault.write('myanimelistCredentials', TOKEN)
    r.fake.key = 'another-user'
    await r.vault.read(KEY)
    await r.vault.read('myanimelistCredentials')
    await r.vault.read(KEY)
    expect(r.onLocked.mock.calls).toEqual([[KEY], ['myanimelistCredentials']])
  })

  it('a stored value that is not a vault blob reads as locked and is left alone', async () => {
    const r = rig({ async: isAsync, seed: { [KEY]: { access_token: 'raw' } } })
    expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
    expect(r.store.get(KEY)).toEqual({ access_token: 'raw' })
  })

  describe('the encrypt/commit split', () => {
    it('encrypt resolves to a blob and stores nothing', async () => {
      const r = rig({ async: isAsync, seed: { [KEY]: null } })
      const blob = await r.vault.encrypt(TOKEN)
      expect(blob).toMatchObject({ v: 1, enc: 'safeStorage' })
      expect(r.set).not.toHaveBeenCalled()
      expect(r.store.get(KEY)).toBeNull()
    })

    // Mutation check: make `commit` async (store after an await) and the
    // next-line assertion reds.
    it('commit is synchronous: it returns undefined and the key holds the blob on the very next line', async () => {
      const r = rig({ async: isAsync })
      const blob = await r.vault.encrypt(TOKEN)
      const out = r.vault.commit(KEY, blob)
      expect(r.store.get(KEY)).toEqual(blob)
      expect(out).toBeUndefined()
      expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
    })

    it('commit(key, null) clears the key and calls no safeStorage member', async () => {
      const r = rig({ async: isAsync })
      r.store.set(KEY, await r.vault.encrypt(TOKEN))
      const touched = r.fake.touched.length
      const getterCalls = r.fake.getter.mock.calls.length
      r.vault.commit(KEY, null)
      expect(r.store.get(KEY)).toBeNull()
      expect(r.fake.touched.length).toBe(touched)
      expect(r.fake.getter.mock.calls.length).toBe(getterCalls)
    })

    it('commit refuses a key that is not a vault key', () => {
      const r = rig({ async: isAsync })
      expect(() => r.vault.commit('shikimoriCredentials' as VaultKey, null)).toThrow(
        /not a vault key/
      )
    })
  })

  describe('the conditional write', () => {
    it('with `if` returning false, nothing is stored', async () => {
      const r = rig({ async: isAsync })
      expect(await r.vault.write(KEY, TOKEN, { if: () => false })).toBe(false)
      expect(r.set).not.toHaveBeenCalled()
      expect(r.store.get(KEY)).toBeNull()
    })

    it('with no `if`, or `if` true, it stores', async () => {
      const r = rig({ async: isAsync })
      expect(await r.vault.write(KEY, TOKEN, { if: () => true })).toBe(true)
      expect(r.store.get(KEY)).toMatchObject({ enc: 'safeStorage' })
    })

    // Mutation check: evaluate `if` before the encrypt's await and this reds.
    it('`if` is read after the encrypt, so a guard that flips during the encrypt skips the store', async () => {
      const r = rig({ async: isAsync })
      let current = true
      if (isAsync) {
        r.fake.hold = true
        const pending = r.vault.write(KEY, TOKEN, { if: () => current })
        await vi.waitFor(() => expect(r.fake.held).toBe(1))
        current = false
        r.fake.release()
        expect(await pending).toBe(false)
      } else {
        r.fake.onEncrypt = () => (current = false)
        expect(await r.vault.write(KEY, TOKEN, { if: () => current })).toBe(false)
      }
      expect(r.set).not.toHaveBeenCalled()
      expect(r.store.get(KEY)).toBeNull()
    })

    it('write(key, null) commits null with no encrypt, synchronously within the call', async () => {
      const r = rig({ async: isAsync })
      r.store.set(KEY, await r.vault.encrypt(TOKEN))
      const touched = r.fake.touched.length
      const pending = r.vault.write(KEY, null)
      expect(r.store.get(KEY)).toBeNull()
      expect(await pending).toBe(true)
      expect(r.fake.touched.length).toBe(touched)
    })
  })

  it('Disconnect clears a locked blob: commit(key, null) leaves null and calls no safeStorage member', async () => {
    const r = rig({ async: isAsync })
    await r.vault.write(KEY, TOKEN)
    r.fake.key = 'another-user'
    expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
    const touched = r.fake.touched.length
    const getterCalls = r.fake.getter.mock.calls.length
    r.vault.commit(KEY, null)
    expect(r.store.get(KEY)).toBeNull()
    expect(r.fake.touched.length).toBe(touched)
    expect(r.fake.getter.mock.calls.length).toBe(getterCalls)
  })

  describe('the plain-to-encrypted upgrade', () => {
    const PLAIN: VaultBlob = { v: 1, enc: 'plain', data: JSON.stringify(TOKEN) }

    it('a plain blob read with encryption available is rewritten encrypted and reads back the same value', async () => {
      const r = rig({ async: isAsync, seed: { [KEY]: PLAIN } })
      expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
      expect(r.store.get(KEY)).toMatchObject({ v: 1, enc: 'safeStorage' })
      expect(bytes(r)).not.toContain('al-SECRET-token')
      expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
    })

    it('a plain blob whose JSON doesn’t parse reads as locked and is left alone', async () => {
      const r = rig({ async: isAsync, seed: { [KEY]: { v: 1, enc: 'plain', data: '{nope' } } })
      const before = bytes(r)
      expect(await r.vault.read(KEY)).toEqual({ state: 'locked' })
      expect(bytes(r)).toBe(before)
    })

    it('an upgrade whose encrypt throws keeps the plain blob and still returns the value', async () => {
      const r = rig({ async: isAsync, seed: { [KEY]: PLAIN } })
      const before = bytes(r)
      r.fake.onEncrypt = () => {
        throw new Error('keyring went away')
      }
      expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'plain' })
      expect(bytes(r)).toBe(before)
      expect(r.warn).toHaveBeenCalledWith(expect.stringContaining('keyring went away'))
    })

    it('with encryption unavailable, the plain blob stays byte-identical', async () => {
      const r = rig({ async: isAsync, available: false, seed: { [KEY]: PLAIN } })
      const before = bytes(r)
      expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'plain' })
      expect(bytes(r)).toBe(before)
      expect(r.set).not.toHaveBeenCalled()
    })

    // On 41.10.7 this is the only live path through the guarded write-back
    // (`shouldReEncrypt` needs the async backend), so it runs on both.
    it('a logout landing during the upgrade’s encrypt leaves the key null', async () => {
      const r = rig({ async: isAsync, seed: { [KEY]: PLAIN } })
      if (isAsync) {
        r.fake.hold = true
        const pending = r.vault.read(KEY)
        await vi.waitFor(() => expect(r.fake.held).toBe(1))
        await r.vault.write(KEY, null)
        r.fake.release()
        await pending
      } else {
        r.fake.onEncrypt = () => void r.vault.write(KEY, null)
        await r.vault.read(KEY)
      }
      expect(r.store.get(KEY)).toBeNull()
    })

    it('a fresh sign-in landing during the upgrade’s encrypt wins', async () => {
      const r = rig({ async: isAsync, seed: { [KEY]: PLAIN } })
      const fresh: VaultBlob = { v: 1, enc: 'plain', data: '{"access_token":"fresh"}' }
      r.fake.onEncrypt = () => {
        r.fake.onEncrypt = null
        r.vault.commit(KEY, fresh)
      }
      await r.vault.read(KEY)
      expect(r.store.get(KEY)).toEqual(fresh)
    })
  })

  it('every method except commit returns a promise; commit is synchronous', async () => {
    const r = rig({ async: isAsync })
    const encrypted = r.vault.encrypt(TOKEN)
    const wrote = r.vault.write('myanimelistCredentials', TOKEN)
    const read = r.vault.read(KEY)
    const has = r.vault.has(KEY)
    for (const p of [encrypted, wrote, read, has]) expect(p).toBeInstanceOf(Promise)
    expect(r.vault.commit(KEY, await encrypted)).toBeUndefined()
    await Promise.all([wrote, read, has])
  })
})

describe('the async backend only', () => {
  it('re-encrypts and writes back when decrypt reports shouldReEncrypt', async () => {
    const r = rig({ async: true })
    await r.vault.write(KEY, TOKEN)
    const before = bytes(r)
    r.fake.shouldReEncrypt = true
    expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
    expect(bytes(r)).not.toBe(before)
    expect(r.store.get(KEY)).toMatchObject({ v: 1, enc: 'safeStorage' })
    r.fake.shouldReEncrypt = false
    expect(await r.vault.read(KEY)).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
  })

  it('the re-encrypt write-back loses to a logout landing while it is pending', async () => {
    const r = rig({ async: true })
    await r.vault.write(KEY, TOKEN)
    r.fake.shouldReEncrypt = true
    r.fake.hold = true
    const pending = r.vault.read(KEY)
    await vi.waitFor(() => expect(r.fake.held).toBe(1))
    await r.vault.write(KEY, null)
    r.fake.release()
    expect(await pending).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
    expect(r.store.get(KEY)).toBeNull()
  })

  it('the re-encrypt write-back never stores plain over an encrypted blob', async () => {
    const r = rig({ async: true })
    await r.vault.write(KEY, TOKEN)
    const before = bytes(r)
    r.fake.shouldReEncrypt = true
    const read = r.vault.read(KEY)
    // Lands after the read's first look and before its write-back's encrypt.
    r.fake.available = false
    expect(await read).toEqual({ state: 'ok', value: TOKEN, mode: 'safeStorage' })
    expect(bytes(r)).toBe(before)
  })
})

describe('never touching safeStorage when it has nothing to do', () => {
  it.each(VAULT_KEYS)(
    'a null %s reads as empty, and has() is false, without the getter or any member',
    async (key) => {
      const r = rig({ async: true })
      expect(await r.vault.read(key)).toEqual({ state: 'empty' })
      expect(await r.vault.has(key)).toBe(false)
      expect(r.fake.untouched()).toBe(true)
    }
  )

  it('has() on a locked blob is true and calls neither the getter nor any member', async () => {
    const store = new InMemoryStorage({
      anilistCredentials: { v: 1, enc: 'safeStorage', data: 'bm90LWRlY3J5cHRhYmxl' }
    })
    const fake = createFakeSafeStorage({ async: true })
    const vault = createCredentialVault({ store, safeStorage: fake.holder, warn: () => {} })
    expect(await vault.has('anilistCredentials')).toBe(true)
    expect(fake.untouched()).toBe(true)
    expect(await vault.read('anilistCredentials')).toEqual({ state: 'locked' })
  })
})

describe('the safeStorage holder', () => {
  it('waits for attach, evaluates the getter once, and logs the Linux backend once', async () => {
    const logs: string[] = []
    const holder = createSafeStorageHolder({ platform: 'linux', log: (m) => logs.push(m) })
    const fake = createFakeSafeStorage()
    const getter = vi.fn(() => fake.instance)
    let resolved = false
    const first = holder.get().then((s) => ((resolved = true), s))
    await flush()
    expect(resolved).toBe(false)
    holder.attach(getter)
    expect(await first).toBe(fake.instance)
    expect(await holder.get()).toBe(fake.instance)
    expect(getter).toHaveBeenCalledTimes(1)
    expect(logs).toEqual(['[vault] safeStorage backend: gnome_libsecret'])
  })

  it('logs no backend off Linux', async () => {
    const logs: string[] = []
    const holder = createSafeStorageHolder({ platform: 'darwin', log: (m) => logs.push(m) })
    const fake = createFakeSafeStorage()
    holder.attach(() => fake.instance)
    await holder.get()
    expect(logs).toEqual([])
    expect(fake.touched).not.toContain('getSelectedStorageBackend')
  })
})
