import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFirstEntry } from '../eval/unzip.ts';

const hasZip = spawnSync('zip', ['-v']).status === 0;
const payload = Array.from({ length: 4000 }, (_, i) => `${1583971200000 + i * 60000},1,2,3,${i},5`).join('\n');

test('extractFirstEntry: normal deflate zip', { skip: !hasZip }, () => {
  const d = mkdtempSync(join(tmpdir(), 'zip-'));
  writeFileSync(join(d, 'a.csv'), payload);
  execFileSync('zip', ['-q', 'out.zip', 'a.csv'], { cwd: d });
  assert.equal(extractFirstEntry(readFileSync(join(d, 'out.zip'))).toString(), payload);
});

test('extractFirstEntry: streamed zip written with a data descriptor', { skip: !hasZip }, () => {
  const d = mkdtempSync(join(tmpdir(), 'zip-'));
  writeFileSync(join(d, 'a.csv'), payload);
  execFileSync('sh', ['-c', 'cat a.csv | zip -q out.zip -'], { cwd: d });
  assert.equal(extractFirstEntry(readFileSync(join(d, 'out.zip'))).toString(), payload);
});

test('extractFirstEntry rejects garbage', () => {
  assert.throws(() => extractFirstEntry(Buffer.from('not a zip file at all, definitely not')), /zip/);
});
