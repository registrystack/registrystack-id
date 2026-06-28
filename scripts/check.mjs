import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = resolve(repoRoot, 'public');
const tempDir = mkdtempSync(join(tmpdir(), 'registrystack-id-'));

function listFiles(root, dir = root) {
  const result = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      result.push(...listFiles(root, path));
    } else {
      result.push(relative(root, path));
    }
  }
  return result;
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

try {
  const build = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, OUTPUT_DIR: tempDir },
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const expected = listFiles(tempDir);
  const actual = listFiles(publicDir);
  const expectedList = expected.join('\n');
  const actualList = actual.join('\n');
  if (expectedList !== actualList) {
    console.error('public/ file list is not generated from current catalogs');
    console.error('expected:\n' + expectedList);
    console.error('actual:\n' + actualList);
    process.exit(1);
  }

  for (const file of expected) {
    const expectedDigest = digest(join(tempDir, file));
    const actualDigest = digest(join(publicDir, file));
    if (expectedDigest !== actualDigest) {
      console.error(`public/${file} is not generated from current catalogs`);
      process.exit(1);
    }
  }

  console.log('public/ matches generated output');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
