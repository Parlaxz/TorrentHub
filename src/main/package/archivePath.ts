import { UnsafeArchivePathError } from './errors.ts';

const WINDOWS_RESERVED_STEMS = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const DRIVE_PREFIX = /^[a-zA-Z]:/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeArchiveRelativePath(input: string): string {
  return input.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
}

function validateSegment(segment: string, original: string): void {
  if (segment === '..') {
    throw new UnsafeArchivePathError(original, 'path traversal segment ".." is not allowed');
  }
  if (segment === '.' || segment.length === 0) {
    throw new UnsafeArchivePathError(original, 'empty or "." segments are not allowed');
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    throw new UnsafeArchivePathError(
      original,
      'segments must not end with a dot or a space (Windows compatibility)',
    );
  }
  const stem = segment.split('.', 1)[0].toUpperCase();
  if (WINDOWS_RESERVED_STEMS.has(stem)) {
    throw new UnsafeArchivePathError(
      original,
      `segment uses a reserved Windows device name "${stem}"`,
    );
  }
}

export function validateArchiveRelativePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new UnsafeArchivePathError(String(input), 'archive path must be a non-empty string');
  }
  if (CONTROL_CHARS.test(input)) {
    throw new UnsafeArchivePathError(input, 'control characters are not allowed');
  }

  const normalized = normalizeArchiveRelativePath(input);

  if (normalized.startsWith('/')) {
    throw new UnsafeArchivePathError(input, 'absolute archive paths are not allowed');
  }
  if (DRIVE_PREFIX.test(normalized)) {
    throw new UnsafeArchivePathError(input, 'drive-prefixed archive paths are not allowed');
  }

  const segments = normalized.split('/');
  for (const segment of segments) {
    validateSegment(segment, input);
  }
  return normalized;
}

function withDuplicateSuffix(path: string, n: number): string {
  const slashIndex = path.lastIndexOf('/');
  const dir = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : '';
  const fileName = path.slice(slashIndex + 1);
  const dotIndex = fileName.lastIndexOf('.');
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const ext = dotIndex > 0 ? fileName.slice(dotIndex) : '';
  return `${dir}${stem} (${n})${ext}`;
}

export function resolveArchivePathCollisions(paths: string[]): string[] {
  const assigned = new Map<number, string>();
  const takenByLower = new Map<string, number>();

  for (let i = 0; i < paths.length; i++) {
    let candidate = paths[i];
    let n = 1;
    while (takenByLower.has(candidate.toLowerCase())) {
      n += 1;
      candidate = withDuplicateSuffix(paths[i], n);
    }
    takenByLower.set(candidate.toLowerCase(), i);
    assigned.set(i, candidate);
  }
  return [...assigned.values()];
}
