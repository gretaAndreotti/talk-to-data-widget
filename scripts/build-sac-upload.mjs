// Packaging script — produces the two files needed for SAC upload.
//
// Python analogy: this is like a setup.py or a Makefile target.
// Run it with:  node scripts/build-sac-upload.mjs
//
// Outputs:
//   dist/sac-widget.json           ← copy of the manifest  (upload to SAC first)
//   dist/sac-widget-resources.zip  ← flat ZIP with main.js (upload to SAC second)

import { copyFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')
const dist = resolve(root, 'dist')
const mainJs = resolve(dist, 'main.js')
const manifestSrc = resolve(root, 'sac', 'widget.json')
const manifestDest = resolve(dist, 'sac-widget.json')
const zipDest = resolve(dist, 'sac-widget-resources.zip')

// ── Guard: build must run first ───────────────────────────────────────────
if (!existsSync(mainJs)) {
  console.error('ERROR: dist/main.js not found.')
  console.error('Run  npm run build  first, then retry.')
  process.exit(1)
}

// ── Step 1: copy manifest ─────────────────────────────────────────────────
copyFileSync(manifestSrc, manifestDest)
console.log('✓ Copied sac/widget.json → dist/sac-widget.json')

// ── Step 2: create flat ZIP ───────────────────────────────────────────────
// The ZIP must have main.js at its root (no subfolders).
// SAC-hosted ZIP mode does not support nested paths.
// The -j flag strips directory paths so main.js sits at the ZIP root.
try {
  execSync(`zip -j "${zipDest}" "${mainJs}"`, { stdio: 'inherit' })
  console.log('✓ Created dist/sac-widget-resources.zip')
} catch {
  console.error('ERROR: zip command failed. Run this inside Docker (docker compose run --rm builder npm run build:upload).')
  process.exit(1)
}

// ── Done ──────────────────────────────────────────────────────────────────
console.log('\nSAC upload artifacts ready in dist/:')
console.log('  1.  sac-widget.json           ← upload this first in SAC')
console.log('  2.  sac-widget-resources.zip  ← upload this second (same widget, same version)')
console.log('\nNext: in SAC go to  System → Administration → Custom Widgets')
console.log('      and import the JSON, then import the ZIP for the same widget.')
