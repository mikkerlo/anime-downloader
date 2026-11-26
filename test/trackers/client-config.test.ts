// `myanimelistClientConfig` (#690): only `{ clientId }` is stored, and
// `hasSecret` is computed from the vault's secret blob, never stored.
import { describe, it, expect } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { getClientConfig, setClientConfig } from '../../src/main/trackers/client-config'

function rig(seed: Record<string, unknown> = {}) {
  const store = new InMemoryStorage({
    myanimelistClientConfig: null,
    myanimelistClientSecret: null,
    ...seed
  })
  const fake = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: fake.holder, warn: () => {} })
  return { store, fake, vault }
}

describe('MAL client config', () => {
  it('at the defaults: no client ID and no secret, without touching safeStorage', () => {
    const r = rig()
    expect(getClientConfig(r.store)).toEqual({ clientId: null, hasSecret: false })
    expect(r.fake.untouched()).toBe(true)
  })

  it('hasSecret follows the secret blob: null is false, any blob is true, a locked one included', () => {
    const r = rig({ myanimelistClientConfig: { clientId: 'cid' } })
    expect(getClientConfig(r.store).hasSecret).toBe(false)
    r.store.set('myanimelistClientSecret', { v: 1, enc: 'plain', data: '"s"' })
    expect(getClientConfig(r.store)).toEqual({ clientId: 'cid', hasSecret: true })
    r.store.set('myanimelistClientSecret', { v: 1, enc: 'safeStorage', data: 'bG9ja2Vk' })
    expect(getClientConfig(r.store).hasSecret).toBe(true)
    r.store.set('myanimelistClientSecret', null)
    expect(getClientConfig(r.store).hasSecret).toBe(false)
    expect(r.fake.untouched()).toBe(true)
  })

  it('setClientConfig stores only { clientId } and the secret through the vault', async () => {
    const r = rig()
    await setClientConfig(r.store, r.vault, { clientId: 'cid', secret: 'MAL-SECRET' })
    expect(r.store.get('myanimelistClientConfig')).toEqual({ clientId: 'cid' })
    expect(r.store.get('myanimelistClientSecret')).toMatchObject({ v: 1, enc: 'safeStorage' })
    expect(JSON.stringify(r.store.get('myanimelistClientSecret'))).not.toContain('MAL-SECRET')
    expect(await r.vault.read('myanimelistClientSecret')).toMatchObject({ value: 'MAL-SECRET' })
    expect(getClientConfig(r.store)).toEqual({ clientId: 'cid', hasSecret: true })
  })

  it('no secret keeps the stored one; null clears it', async () => {
    const r = rig()
    await setClientConfig(r.store, r.vault, { clientId: 'a', secret: 'S' })
    const blob = r.store.get('myanimelistClientSecret')
    await setClientConfig(r.store, r.vault, { clientId: 'b' })
    expect(r.store.get('myanimelistClientConfig')).toEqual({ clientId: 'b' })
    expect(r.store.get('myanimelistClientSecret')).toEqual(blob)
    await setClientConfig(r.store, r.vault, { clientId: 'b', secret: null })
    expect(getClientConfig(r.store)).toEqual({ clientId: 'b', hasSecret: false })
  })

  it('commits the ID and the secret together after the encrypt, so overlapping calls never mix them', async () => {
    const r = rig()
    r.fake.hold = true
    const first = setClientConfig(r.store, r.vault, { clientId: 'first', secret: 'S1' })
    const second = setClientConfig(r.store, r.vault, { clientId: 'second', secret: 'S2' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Nothing is stored while either encrypt is pending.
    expect(r.store.get('myanimelistClientConfig')).toBeNull()
    r.fake.release()
    await first
    expect(r.store.get('myanimelistClientConfig')).toEqual({ clientId: 'first' })
    expect(await r.vault.read('myanimelistClientSecret')).toMatchObject({ value: 'S1' })
    r.fake.release()
    await second
    expect(r.store.get('myanimelistClientConfig')).toEqual({ clientId: 'second' })
    expect(await r.vault.read('myanimelistClientSecret')).toMatchObject({ value: 'S2' })
  })
})
