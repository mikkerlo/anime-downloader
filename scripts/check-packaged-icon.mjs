#!/usr/bin/env node
// CI gate: every packaged `app.asar` carries the window icon (#686).
//
// `createWindow` loads the icon from `out/main/../../resources/icon.{ico,png}`.
// In dev and under Playwright that lands on the repo's `resources/`; in a
// package it lands inside `app.asar`, which holds only what `build.files`
// lists. From v1.0.2 it listed only `out/**/*`, so no packaged build loaded the
// window icon and Windows logged `Failed to load image from path`. Nothing that
// runs from the source tree could notice.
//
// So this reads the header of each archive electron-builder wrote under
// `dist/` and requires both icon files in it. Finding no archive at all is an
// error too: a moved output directory must not turn the check into a pass.
//
// The archive header is a Chromium pickle: a UInt32LE at offset 12 holds the
// byte length of the header JSON, which starts at offset 16. The archives are
// found with `readdirSync`, not a shell glob, because the macOS bundle name
// (`Anime DL.app`) has a space in it.
//
// Run: node scripts/check-packaged-icon.mjs [dist-dir]

import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const REQUIRED_ENTRIES = ['resources/icon.ico', 'resources/icon.png']

export function findArchives(distDir) {
  if (!existsSync(distDir)) return []
  const archives = []
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(distDir, entry.name)
    if (entry.name.endsWith('-unpacked')) {
      const asar = join(dir, 'resources', 'app.asar')
      if (existsSync(asar)) archives.push(asar)
    } else if (entry.name.startsWith('mac')) {
      for (const app of readdirSync(dir, { withFileTypes: true })) {
        if (!app.isDirectory() || !app.name.endsWith('.app')) continue
        const asar = join(dir, app.name, 'Contents', 'Resources', 'app.asar')
        if (existsSync(asar)) archives.push(asar)
      }
    }
  }
  return archives.sort()
}

export function readAsarHeader(file) {
  const fd = openSync(file, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if (readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error(`${file}: truncated asar header`)
    const length = prefix.readUInt32LE(12)
    const json = Buffer.alloc(length)
    if (readSync(fd, json, 0, length, 16) !== length) {
      throw new Error(`${file}: truncated asar header`)
    }
    return JSON.parse(json.toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

export function hasEntry(header, path) {
  let node = header
  for (const part of path.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) return false
  }
  return node.files === undefined
}

export function missingEntries(header, required = REQUIRED_ENTRIES) {
  return required.filter((path) => !hasEntry(header, path))
}

export function checkDist(distDir) {
  const archives = findArchives(distDir)
  if (archives.length === 0) {
    return {
      ok: false,
      out: [],
      err: [
        `No packaged app.asar found under ${distDir} ` +
          '(looked for *-unpacked/resources/app.asar and mac*/*.app/Contents/Resources/app.asar).'
      ]
    }
  }
  const out = []
  const err = []
  for (const asar of archives) {
    const missing = missingEntries(readAsarHeader(asar))
    if (missing.length === 0) out.push(`ok  ${asar}: ${REQUIRED_ENTRIES.join(', ')}`)
    else for (const path of missing) err.push(`${asar}: missing ${path}`)
  }
  return { ok: err.length === 0, out, err }
}

function main() {
  const { ok, out, err } = checkDist(process.argv[2] ?? 'dist')
  if (out.length > 0) console.log(out.join('\n'))
  if (err.length > 0) {
    console.error(err.join('\n'))
    console.error('\nAdd the missing files to `build.files` in package.json (see docs/build.md).')
  }
  if (!ok) process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('check-packaged-icon.mjs')) main()
