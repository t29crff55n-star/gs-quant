#!/usr/bin/env node
// Inline smc-engine.js into app.src.html -> index.html (the page GitHub Pages serves).
const fs = require('fs'), path = require('path');
const dir = __dirname;
const engine = fs.readFileSync(path.join(dir, 'smc-engine.js'), 'utf8');
const src = fs.readFileSync(path.join(dir, 'app.src.html'), 'utf8');
if (!src.includes('/*__ENGINE__*/')) throw new Error('placeholder missing');
fs.writeFileSync(path.join(dir, 'index.html'), src.replace('/*__ENGINE__*/', () => engine));
console.log('built index.html', fs.statSync(path.join(dir, 'index.html')).size, 'bytes');
