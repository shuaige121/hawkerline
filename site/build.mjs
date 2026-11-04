#!/usr/bin/env node
// Dependency-free build: copies the site into dist/ and stamps {{ORIGIN}} from site.config.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const { origin } = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
if (!/^https?:\/\/[^/]+(\/[^/]+)*$/.test(origin)) throw new Error('site.config.json: origin must be an absolute URL without a trailing slash');

const SKIP = new Set(['dist', 'build.mjs', 'site.config.json', 'node_modules', '.DS_Store']);
const TEXT = new Set(['.html', '.txt', '.xml', '.css', '.json', '.svg', '.md']);

fs.rmSync(dist, { recursive: true, force: true });
let count = 0;
(function walk(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const s = path.join(src, name), d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) { walk(s, d); continue; }
    if (TEXT.has(path.extname(name))) fs.writeFileSync(d, fs.readFileSync(s, 'utf8').replaceAll('{{ORIGIN}}', origin));
    else fs.copyFileSync(s, d);
    count++;
  }
})(root, dist);

const left = [];
(function scan(dir) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) scan(p);
    else if (TEXT.has(path.extname(n)) && fs.readFileSync(p, 'utf8').includes('{{')) left.push(p);
  }
})(dist);
if (left.length) { console.error('Unreplaced tokens in:', left.join(', ')); process.exit(1); }
console.log(`Built ${count} files to dist/ with origin ${origin}`);
