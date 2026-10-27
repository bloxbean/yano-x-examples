import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSiteServer } from '../../serve.mjs';

test('static server serves browser assets but hides node state, service files and symlink escapes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neon-site-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'site'); await mkdir(root);
  await writeFile(join(root, 'index.html'), 'public page');
  await writeFile(join(root, 'issuer.seed'), 'canary-private');
  await mkdir(join(root, '.yano')); await writeFile(join(root, '.yano', 'key.json'), 'canary-private');
  await mkdir(join(root, 'delegation')); await writeFile(join(root, 'delegation', 'config.json'), 'private config');
  await writeFile(join(directory, 'private.json'), 'canary-private');
  await symlink(join(directory, 'private.json'), join(root, 'escape.json'));
  await symlink(join(root, 'delegation', 'config.json'), join(root, 'internal-alias.json'));
  await symlink(join(root, 'issuer.seed'), join(root, 'seed-alias.json'));
  const server = createSiteServer({ root: root + '/', nodes: [] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(base + '/')).text(), 'public page');
  for (const path of ['/issuer.seed', '/.yano/key.json', '/%2eyano/key.json', '/delegation/config.json', '/escape.json',
    '/%2fdelegation/config.json', '/%2f%2fdelegation/config.json', '/%5cdelegation/config.json',
    '/%2fchain/application.json', '/%2fplugin/private.json', '/%2ftest/private.json',
    '/internal-alias.json', '/seed-alias.json', '/Delegation/config.json', '/%2fDELEGATION/config.json']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path); assert(!await response.text().then(text => text.includes('canary-private')));
  }
});
