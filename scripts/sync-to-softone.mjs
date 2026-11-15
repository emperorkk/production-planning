#!/usr/bin/env node
/**
 * Copy the public/ folder into the SoftOne installation directory so the
 * embedded x=external page stays in sync with the repo.
 *
 * Usage:   npm run sync-embedded
 * Target:  C:\SoftOne\Vlachos Bros\   (override with SOFT1_PATH env var)
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve }                         from 'node:path';
import { fileURLToPath }                                  from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT  = join(REPO_ROOT, 'public');
const DST_ROOT  = process.env.SOFT1_PATH || 'C:\\SoftOne\\Vlachos Bros';

const COPY = [
  'production-planner.html',
  'src'                        // recursive
];

function walk(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    // Skip web-only artifacts
    if (name === 'login.html' || name === 'login.js') continue;
    const s = join(srcDir, name);
    const d = join(dstDir, name);
    if (statSync(s).isDirectory()) walk(s, d);
    else                           { copyFileSync(s, d); console.log('  →', d); }
  }
}

console.log(`Syncing ${SRC_ROOT}  →  ${DST_ROOT}`);
for (const entry of COPY) {
  const s = join(SRC_ROOT, entry);
  const d = join(DST_ROOT, entry);
  if (statSync(s).isDirectory()) walk(s, d);
  else                           { copyFileSync(s, d); console.log('  →', d); }
}
console.log('Done.');
