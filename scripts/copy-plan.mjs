#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [, , src, dst] = process.argv;
if (!src || !dst) {
  process.stderr.write('usage: copy-plan.mjs <src> <dst>\n');
  process.exit(64);
}
try {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  process.stdout.write(dst + '\n');
} catch (err) {
  process.stderr.write(`${err.code || 'ERR'}: ${err.message}\n`);
  process.exit(1);
}
