import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('example launcher forwards its staged plugin directory and preserves the distribution default', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'neon-launcher-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const distribution = join(directory, 'distribution'); const example = join(directory, 'example');
  const staged = join(directory, 'staged plugins');
  for (const path of [join(distribution, 'config'), join(distribution, 'plugins'),
    join(distribution, 'appchain-cluster'), join(example, 'chain'), staged]) await mkdir(path, { recursive: true });
  await writeFile(join(distribution, 'yano.jar'), 'fixture');
  await writeFile(join(example, 'chain/application-appchain.yml'), 'yano: {}\n');
  await writeFile(join(distribution, 'appchain-cluster/cluster.sh'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$YANO_PLUGINS_DIRECTORY"\n', { mode: 0o755 });
  const helper = fileURLToPath(new URL('../../../00-shared/lib/example-cluster.sh', import.meta.url));
  const run = promisify(execFile);
  for (const override of ['', staged]) {
    const result = await run('bash', ['-c', '. "$1"; example_cluster "$2" status', 'test', helper, example],
      { env: { ...process.env, YANO_X_DIST: distribution, EXAMPLE_PLUGINS_DIRECTORY: override } });
    assert.equal(result.stdout.trim(), override || join(distribution, 'plugins'));
  }
});
