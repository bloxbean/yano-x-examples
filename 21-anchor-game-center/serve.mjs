#!/usr/bin/env node
// Local play without touching the members' CORS settings.
//
// Serves this folder and forwards /proxy/<n>/... to member n, so the browser
// only ever talks to its own origin. Open http://localhost:8787/?proxy=1.
//
//   node serve.mjs --local     the cluster from ./cluster start: its members, its
//                              topics.json, and the delegation service beside the site
//   YANO_NODES=http://127.0.0.1:7210,http://127.0.0.1:7211 node serve.mjs
//                              other members; /topics.json is then whatever this folder holds
//
// The delegation service holds the issuer key in its own process state, never
// in a served file; anything under a dot-directory (.yano/) is refused.
// On a hosted site none of this is used: pages call the members directly (they
// must allow the page's origin in CORS) and a delegation service of its own.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { CENTER } from './shared/config.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const LOCAL = process.argv.includes('--local');
const GAMES = join(ROOT, '.yano', 'games');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

let local = null;
if (LOCAL) {
  const config = join(GAMES, 'delegation.json');
  if (!existsSync(config)) {
    console.error('No local cluster settings in .yano/games. Run ./cluster start first.');
    process.exit(1);
  }
  local = JSON.parse(readFileSync(config, 'utf8'));
  const { startDelegationServer } = await import('./delegation/server.mjs');
  await startDelegationServer(config);
}
const NODES = local?.nodes ?? (process.env.YANO_NODES ? process.env.YANO_NODES.split(',') : CENTER.nodes.map((n) => n.url));
const DELEGATIONS = process.env.DELEGATION_URL ?? (local ? `http://127.0.0.1:${local.port}/delegations` : null);

async function forward(req, res, target) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(target, {
    method: req.method,
    headers: { accept: req.headers.accept ?? '*/*', ...(chunks.length ? { 'content-type': 'application/json' } : {}) },
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  if (upstream.body) Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  else res.end();
}

async function file(res, pathname) {
  const relative = decodeURIComponent(pathname.endsWith('/') ? `${pathname}index.html` : pathname);
  const path = normalize(join(ROOT, relative));
  // Never serve outside this folder, nor anything under a dot-directory (.yano holds keys).
  if (!path.startsWith(ROOT) || path.slice(ROOT.length).split(sep).some((part) => part.startsWith('.'))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/proxy/nodes') {
      // Tells the page which members it is proxying, so a local cluster can stand in for the showcase.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nodes: NODES, custom: Boolean(local || process.env.YANO_NODES) }));
      return;
    }
    if (url.pathname === '/topics.json' && local) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(await readFile(join(GAMES, 'topics.json')));
      return;
    }
    if (url.pathname === '/delegations' && DELEGATIONS) {
      await forward(req, res, DELEGATIONS);
      return;
    }
    const match = url.pathname.match(/^\/proxy\/(\d+)(\/.*)$/);
    if (match) {
      const target = NODES[Number(match[1])];
      if (!target) { res.writeHead(404).end('no such member'); return; }
      await forward(req, res, `${target}${match[2]}${url.search}`);
    } else {
      await file(res, url.pathname);
    }
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`proxy error: ${error.message}`);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Anchor Games on http://localhost:${PORT}/?proxy=1`);
  NODES.forEach((n, i) => console.log(`  /proxy/${i} → ${n}`));
  if (DELEGATIONS) console.log(`  /delegations → ${DELEGATIONS}`);
});
