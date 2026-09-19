import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(
  resolve(repoRoot, '.github/workflows/deploy-cloudflare-workers.yml'),
  'utf8',
);

test('release publication deploys one reviewed exact released catalog', () => {
  for (const input of [
    'released_tag:',
    'source_sha:',
    'catalog_sha256:',
    'request_id:',
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}\\n        [^\\n]+\\n        required: true$`, 'm'));
  }
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /Released Registry Stack tag must be annotated/);
  assert.match(workflow, /refs\/remotes\/origin\/main/);
  assert.match(workflow, /actual_catalog_sha256/);
  assert.match(workflow, /inputs do not match the reviewed publisher bundle/);
  assert.doesNotMatch(workflow, /npm run import:catalog/);
  assert.match(workflow, /npm run check:upstream/);
  assert.match(workflow, /npm run smoke:catalog/);
  assert.match(workflow, /npm run smoke:live/);
});
