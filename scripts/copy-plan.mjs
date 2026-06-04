#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gitRepoRoot } from './lib/codex-exec.mjs';

const [, , src, dst] = process.argv;
if (!src || !dst) {
  process.stderr.write('usage: copy-plan.mjs <src> <dst>\n');
  process.exit(64);
}
// Anchor relative src/dst to the git repo root (matching the wrappers), so a
// stray `cd <subdir>` in the caller's shell can't land the copy in the wrong
// directory. Absolute paths pass through. Fall back to process.cwd() when not
// in a repo / git unavailable.
const base = await gitRepoRoot(process.cwd()).catch(() => process.cwd());
const resolveStable = (p) => (path.isAbsolute(p) ? p : path.resolve(base, p));
const srcAbs = resolveStable(src);
const dstAbs = resolveStable(dst);
try {
  await fs.mkdir(path.dirname(dstAbs), { recursive: true });
  await fs.copyFile(srcAbs, dstAbs);
  process.stdout.write(dstAbs + '\n');
} catch (err) {
  process.stderr.write(`${err.code || 'ERR'}: ${err.message}\n`);
  process.exit(1);
}
