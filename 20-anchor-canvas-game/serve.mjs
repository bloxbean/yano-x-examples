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
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { CONFIG } from './js/config.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const NODES = process.env.YANO_NODES ? process.env.YANO_NODES.split(',') : CONFIG.nodes.map((n) => n.url);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

async function proxy(req, res, member, rest) {
  const target = NODES[member];
  if (!target) { res.writeHead(404).end('no such member'); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(`${target}${rest}`, {
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
  const path = normalize(join(ROOT, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
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
  if (url.pathname === '/proxy/nodes') {
    // Tells the page which members it is proxying, so a local cluster can stand in for the showcase.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nodes: NODES, custom: Boolean(process.env.YANO_NODES) }));
    return;
  }
  const match = url.pathname.match(/^\/proxy\/(\d+)(\/.*)$/);
  try {
    if (match) await proxy(req, res, Number(match[1]), match[2] + url.search);
    else await file(res, url.pathname);
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`proxy error: ${error.message}`);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Anchor Canvas on http://localhost:${PORT}/?proxy=1`);
  NODES.forEach((n, i) => console.log(`  /proxy/${i} → ${n}`));
});
