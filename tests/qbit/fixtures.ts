/** Shared fixtures for mocked WebUI responses. */

import { jsonResponse } from './mock';

export const HASH = '0123456789abcdef0123456789abcdef01234567';
export const HASH_V2 = 'a'.repeat(64);

export function fetchMetadataFull(): unknown {
  return {
    hash: HASH,
    infohash_v1: HASH,
    infohash_v2: '',
    info: {
      files: [
        { path: 'Movie/movie.mkv', length: 1_000_000 },
        { path: 'Movie/sample.mkv', length: 50_000 },
        { path: 'Movie/subs.srt', length: 10_000 },
      ],
      length: 1_060_000,
      name: 'Movie 2024',
      piece_length: 16_384,
      pieces_num: 65,
      private: false,
    },
    trackers: [{ url: 'http://tracker/announce', tier: 0 }],
    webseeds: [],
  };
}

export function pendingInfoHashOnly(): unknown {
  return { hash: HASH, infohash_v1: HASH, infohash_v2: '' };
}

export function fileList(priorities?: number[], progress?: number[]): unknown[] {
  const sizes = [1_000_000, 50_000, 10_000];
  return sizes.map((size, index) => ({
    index,
    name: `Movie/${['movie.mkv', 'sample.mkv', 'subs.srt'][index]}`,
    size,
    progress: progress?.[index] ?? 0,
    priority: priorities?.[index] ?? 1,
    availability: 0,
    piece_range: [index * 10, index * 10 + 9],
    ...(index === 0 ? { is_seed: false } : {}),
  }));
}

export function torrentInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: HASH,
    name: 'Movie 2024',
    state: 'downloading',
    progress: 0.5,
    size: 1_060_000,
    total_size: 1_060_000,
    downloaded: 530_000,
    downloaded_session: 100_000,
    completed: 530_000,
    amount_left: 530_000,
    dlspeed: 262_144,
    upspeed: 1_024,
    eta: 120,
    num_seeds: 3,
    num_complete: 12,
    num_leechs: 2,
    num_incomplete: 40,
    category: '',
    tags: [],
    save_path: 'C:/jobs/job-1/',
    content_path: 'C:/jobs/job-1/Movie 2024',
    completion_on: 0,
    added_on: Math.floor(Date.now() / 1000),
    availability: 1.5,
    magnet_uri: `magnet:?xt=urn:btih:${HASH}&dn=Movie%202024`,
    auto_tmm: false,
    ...overrides,
  };
}

export function versionRoutes(webApi = '2.11.9', qbt = 'v5.2.0'): Record<string, Response> {
  return {
    '/api/v2/app/webapiVersion': text(webApi),
    '/api/v2/app/version': text(qbt),
  };
}

function text(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

export { jsonResponse };
