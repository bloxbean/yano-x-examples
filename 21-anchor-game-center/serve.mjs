#!/usr/bin/env node
// Local play without touching the cluster's CORS settings.
//
// Serves this folder and forwards /proxy/<n>/... to member n, so the browser
// only ever talks to its own origin. Open http://localhost:8787/?proxy=1.
//
//   node serve.mjs                                   # the showcase members from js/config.js
//   YANO_NODES=http://127.0.0.1:7070,http://127.0.0.1:7071,http://127.0.0.1:7072 node serve.mjs
//
// On GitHub Pages none of this is used: the page calls the members directly,
// and they must list the page's origin in quarkus.http.cors.origins.

import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { CENTER } from './shared/config.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const NODES = process.env.YANO_NODES ? process.env.YANO_NODES.split(',') : CENTER.nodes.map((n) => n.url);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const publicPath = path => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return !parts.some(part => part.startsWith('.'))
    && !['delegation', 'chain', 'test', 'plugin'].includes(parts[0]?.toLowerCase()) && Boolean(TYPES[extname(path)]);
};

async function proxy(req, res, nodes, member, rest) {
  const target = nodes[member];
  if (!target) { res.writeHead(404).end('no such member'); return; }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) { res.writeHead(413).end('request too large'); return; }
    chunks.push(chunk);
  }
  const upstream = await fetch(`${target}${rest}`, {
    method: req.method,
    redirect: 'error', signal: AbortSignal.timeout(15000),
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

async function file(res, pathname, root) {
  const decoded = decodeURIComponent(pathname.endsWith('/') ? `${pathname}index.html` : pathname);
  // The local site must never expose .yano state, key files, source-service configuration, or symlink targets.
  const path = normalize(join(root, decoded));
  if (!publicPath(decoded) || !path.startsWith(root)) { res.writeHead(404).end('not found'); return; }
  try {
    const canonical = await realpath(path);
    const canonicalRoot = await realpath(root);
    if (!canonical.startsWith(canonicalRoot + '/') || !publicPath(canonical.slice(canonicalRoot.length + 1))) {
      res.writeHead(404).end('not found'); return;
    }
    const body = await readFile(canonical);
    res.writeHead(200, { 'content-type': TYPES[extname(path)], 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

export function createSiteServer({ nodes = NODES, root = ROOT } = {}) {
 root = resolve(root) + '/';
 const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/proxy/nodes') {
    // Tells the page which members it is proxying, so a local cluster can stand in for the showcase.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nodes, custom: Boolean(process.env.YANO_NODES) }));
    return;
  }
  const match = url.pathname.match(/^\/proxy\/(\d+)(\/.*)$/);
  try {
    if (match) await proxy(req, res, nodes, Number(match[1]), match[2] + url.search);
    else if (req.method === 'GET' || req.method === 'HEAD') await file(res, url.pathname, root);
    else res.writeHead(405).end();
  } catch {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('request failed');
  }
 });
 server.requestTimeout = 20000; server.headersTimeout = 10000;
 return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 createSiteServer().listen(PORT, '127.0.0.1', () => {
  console.log(`Anchor Games on http://localhost:${PORT}/?proxy=1`);
  NODES.forEach((n, i) => console.log(`  /proxy/${i} → ${n}`));
 });
}
