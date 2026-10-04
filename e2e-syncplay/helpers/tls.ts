// A throwaway CA + leaf for the local Syncplay server. The app's client is
// TLS-only (it fails the handshake when the server answers `startTLS: false`),
// so certificates are not optional for this rig. The pitfalls, each scripted
// here rather than rediscovered:
//
//  - `--tls` takes a **directory** that must hold all three of `privkey.pem`,
//    `cert.pem` and `chain.pem`. Miss one and the server silently serves
//    plaintext, which then reads as a client bug.
//  - The leaf needs `subjectAltName = IP:127.0.0.1, DNS:localhost`; the app
//    connects by IP.
//  - The app trusts the chain only through `NODE_EXTRA_CA_CERTS` pointed at
//    the CA, which `duo.ts` sets per instance.
//  - The upgrade is StartTLS, not TLS-on-connect, so a bare
//    `openssl s_client -connect` hangs even when TLS is healthy.
//    `probeStartTls()` sends the StartTLS request and upgrades the socket.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'

export interface TlsDir {
  dir: string
  caPath: string
}

const openssl = (args: string[], cwd: string): void => {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
}

export function makeTlsDir(root: string): TlsDir {
  const dir = path.join(root, 'tls')
  fs.mkdirSync(dir, { recursive: true })
  openssl(
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=anime-dl e2e CA'
    ],
    dir
  )
  openssl(
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'privkey.pem',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=127.0.0.1'
    ],
    dir
  )
  fs.writeFileSync(
    path.join(dir, 'leaf.ext'),
    'subjectAltName = IP:127.0.0.1, DNS:localhost\nbasicConstraints = CA:FALSE\nkeyUsage = digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\n'
  )
  openssl(
    [
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'cert.pem',
      '-days',
      '2',
      '-extfile',
      'leaf.ext'
    ],
    dir
  )
  fs.copyFileSync(path.join(dir, 'ca.pem'), path.join(dir, 'chain.pem'))
  for (const f of ['privkey.pem', 'cert.pem', 'chain.pem']) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`TLS dir is missing ${f}`)
  }
  return { dir, caPath: path.join(dir, 'ca.pem') }
}

/** Resolves when the server's StartTLS upgrade verifies against `caPath`;
 *  rejects on a plaintext answer, a handshake error or a 5 s timeout. */
export function probeStartTls(port: number, caPath: string): Promise<void> {
  const ca = fs.readFileSync(caPath)
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () =>
      s.write(JSON.stringify({ TLS: { startTLS: 'send' } }) + '\r\n')
    )
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error('StartTLS probe timed out'))
    }, 5000)
    s.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    s.once('data', (d) => {
      if (!/"startTLS"\s*:\s*"true"/.test(String(d))) {
        clearTimeout(timer)
        s.destroy()
        reject(new Error(`server did not offer TLS: ${String(d).trim()}`))
        return
      }
      const t = tls.connect({ socket: s, ca, host: '127.0.0.1' }, () => {
        clearTimeout(timer)
        const ok = t.authorized
        t.destroy()
        if (ok) resolve()
        else reject(new Error(`TLS not authorized: ${String(t.authorizationError)}`))
      })
      t.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  })
}
