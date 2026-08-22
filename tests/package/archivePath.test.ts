import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeArchiveRelativePath,
  resolveArchivePathCollisions,
  validateArchiveRelativePath,
} from '../../src/main/package/index.ts';
import { UnsafeArchivePathError } from '../../src/main/package/errors.ts';

describe('validateArchiveRelativePath', () => {
  const valid = [
    'movie.mkv',
    'sub/dir/file.mp4',
    'a/b/c/deep.iso',
    'Season 1/Episode 2 - Pilot.mkv',
    'archive.tar.7z',
  ];

  for (const p of valid) {
    it(`accepts "${p}"`, () => {
      assert.equal(validateArchiveRelativePath(p), p);
    });
  }

  it('normalizes backslashes to forward slashes', () => {
    assert.equal(validateArchiveRelativePath('sub\\dir\\file.rar'), 'sub/dir/file.rar');
  });

  it('collapses duplicate slashes', () => {
    assert.equal(validateArchiveRelativePath('a//b.txt'), 'a/b.txt');
  });

  const invalid: Array<[string, string]> = [
    ['../evil.mkv', 'traversal'],
    ['a/../../evil.bin', 'nested traversal'],
    ['..', 'bare traversal'],
    ['/etc/passwd', 'absolute unix'],
    ['C:/Windows/system32.dll', 'drive prefix forward'],
    ['C:\\Windows\\system32.dll', 'drive prefix backslash'],
    ['c:file.bin', 'lowercase drive prefix'],
    ['\\\\server\\share\\file', 'UNC path'],
    ['dir/', 'trailing slash'],
    ['a/./b', 'dot segment'],
    ['file.', 'segment ending with dot'],
    ['file ', 'segment ending with space'],
    ['con', 'reserved device name'],
    ['NUL.txt', 'reserved device name with extension'],
    ['com1.mp4', 'reserved COM port name'],
    ['lpt9.prn', 'reserved LPT name'],
    ['a\u0000b', 'control character'],
    ['', 'empty string'],
  ];

  for (const [p, label] of invalid) {
    it(`rejects ${label}: "${p}"`, () => {
      assert.throws(() => validateArchiveRelativePath(p), UnsafeArchivePathError);
    });
  }
});

describe('normalizeArchiveRelativePath', () => {
  it('is a pure string transform', () => {
    assert.equal(normalizeArchiveRelativePath('x\\y//z'), 'x/y/z');
  });
});

describe('resolveArchivePathCollisions', () => {
  it('keeps first occurrence and suffixes later duplicates deterministically', () => {
    assert.deepEqual(resolveArchivePathCollisions(['a.txt', 'a.txt']), [
      'a.txt',
      'a (2).txt',
    ]);
  });

  it('treats paths case-insensitively as colliding but preserves original casing', () => {
    assert.deepEqual(resolveArchivePathCollisions(['A.TXT', 'a.txt']), [
      'A.TXT',
      'a (2).txt',
    ]);
  });

  it('handles nested collisions inside directories', () => {
    assert.deepEqual(resolveArchivePathCollisions(['d/f.bin', 'd/f.bin', 'd/f.bin']), [
      'd/f.bin',
      'd/f (2).bin',
      'd/f (3).bin',
    ]);
  });

  it('suffixes files without an extension', () => {
    assert.deepEqual(resolveArchivePathCollisions(['README', 'README']), [
      'README',
      'README (2)',
    ]);
  });

  it('does not treat dotfiles as extension-only stems', () => {
    assert.deepEqual(resolveArchivePathCollisions(['.gitignore', '.gitignore']), [
      '.gitignore',
      '.gitignore (2)',
    ]);
  });

  it('is deterministic for identical input order', () => {
    const input = ['x/a', 'y/a', 'x/a', 'y/A'];
    assert.deepEqual(
      resolveArchivePathCollisions(input),
      resolveArchivePathCollisions([...input]),
    );
  });
});
