import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import entryPlugin from './tailwind-entry-postcss.cjs';
import config from '../postcss.config.mjs';

assert.deepEqual(Object.keys(config.plugins), [path.resolve('scripts/tailwind-entry-postcss.cjs')],
  'Compiler workers must receive an absolute plugin path');

const processor = postcss([entryPlugin()]);
const globalFile = path.resolve('app/globals.css');
const globalResult = await processor.process(await readFile(globalFile, 'utf8'), { from: globalFile });
assert.match(globalResult.css, /box-sizing:\s*border-box/);
assert.match(globalResult.css, /--bg:\s*#000/);
assert.doesNotMatch(globalResult.css, /@import\s+["']tailwindcss["']/);
assert.match(globalResult.css, /tailwindcss v/);
const moduleFile = path.resolve('components/ide-panel.module.css');
const original = await readFile(moduleFile, 'utf8');
for (let iteration = 0; iteration < 3; iteration++) {
  const moduleResult = await processor.process(original, { from: moduleFile });
  assert.equal(moduleResult.css, original, 'Plain module declarations must survive reused worker processing byte-for-byte');
}
console.log('CSS processing verification passed: global preflight retained, reused module processing unchanged.');
