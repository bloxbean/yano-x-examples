#!/usr/bin/env node
// Vendored SDK verification needs no source checkout. --source is an optional maintainer comparison.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../shared/topic-client/', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const arguments_ = process.argv.slice(2);
if (arguments_.length && (arguments_.length !== 2 || arguments_[0] !== '--source')) {
  throw new Error('Usage: node scripts/check-topic-client.mjs [--source /path/to/sdk/javascript]');
}
const source = arguments_.length ? pathToFileURL(resolve(arguments_[1]) + '/') : null;
const names = (await readdir(root)).filter(name => name.endsWith('.mjs')).sort();
if (names.join(',') !== Object.keys(provenance.files).sort().join(',')) throw new Error('SDK inventory changed');
for (const name of names) {
  const data = await readFile(new URL(name, root));
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== provenance.files[name]) throw new Error(`Vendored SDK digest mismatch: ${name}`);
  if (source && !data.equals(await readFile(new URL(name, source)))) throw new Error(`SDK source differs: ${name}`);
}
console.log(`Verified ${names.length} vendored topic SDK modules (${provenance.hostVersion})`);
