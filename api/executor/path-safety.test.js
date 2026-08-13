import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRelativePath, safeFiles } from './path-safety.js';

test('accepts ordinary relative paths', () => {
  assert.equal(safeRelativePath('src/app.js'), 'src/app.js');
  assert.equal(safeRelativePath('src\\app.js'), 'src/app.js');
});

test('normalizes current-directory segments', () => {
  assert.equal(safeRelativePath('a/./b'), 'a/b');
  assert.equal(safeRelativePath('./a/b'), 'a/b');
  assert.equal(safeRelativePath('a//./b/'), 'a/b');
});

test('rejects traversal segments after separator normalization', () => {
  for (const value of [
    '../secret.txt',
    '..\\secret.txt',
    'foo/../secret.txt',
    'foo\\..\\secret.txt',
    'foo/../../secret.txt',
    '..//',
  ]) {
    assert.throws(() => safeRelativePath(value), /traversal|Absolute file paths/i);
  }
});

test('rejects absolute paths and Windows drive paths', () => {
  assert.throws(() => safeRelativePath('/etc/passwd'), /Absolute file paths/);
  assert.throws(() => safeRelativePath('C:\\Windows\\system32\\x'), /Absolute file paths/);
});

test('safeFiles preserves file content and enforces payload limits', () => {
  assert.deepEqual(
    safeFiles([{ path: 'src/main.js', content: 'console.log(1)' }]),
    [{ path: 'src/main.js', content: 'console.log(1)' }],
  );
  assert.throws(
    () => safeFiles([{ path: '../../escape', content: '' }]),
    /traversal/i,
  );
});
