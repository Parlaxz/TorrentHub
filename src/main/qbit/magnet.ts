/**
 * Magnet URI / torrent URL validation and infohash extraction.
 *
 * The qBittorrent WebAPI does not expose a client-side "parse magnet" endpoint
 * (fetchMetadata validates server-side), so the adapter pre-validates locally
 * to produce precise typed errors before any network call.
 */

import { InvalidTorrentSourceError } from './errors';
import type { TorrentSourceKind } from './types';

export interface ParsedSource {
  kind: TorrentSourceKind;
  /** Original, unmodified source string. */
  raw: string;
  /** Magnet-only fields. */
  displayName?: string;
  infoHashV1?: string;
  infoHashV2?: string;
}

const BTIH_V1_HEX = /^[a-fA-F0-9]{40}$/;
const BTMH_V2_HEX = /^[a-fA-F0-9]{64}$/;

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32ToHex(input: string): string | null {
  const cleaned = input.replace(/=+$/, '').toLowerCase();
  if (!/^[a-z2-7]+$/.test(cleaned)) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates a magnet URI or HTTP(S) .torrent URL.
 * Throws InvalidTorrentSourceError with a precise reason on failure.
 */
export function parseTorrentSource(source: string): ParsedSource {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new InvalidTorrentSourceError('Torrent source is empty');
  }
  const trimmed = source.trim();

  if (trimmed.toLowerCase().startsWith('magnet:')) {
    return parseMagnet(trimmed);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidTorrentSourceError('Torrent source is neither a magnet URI nor a valid URL', {
      source: trimmed,
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidTorrentSourceError(
      `Unsupported URL scheme "${url.protocol}" — only http/https .torrent URLs are supported`,
      { source: trimmed },
    );
  }

  return { kind: 'url', raw: trimmed };
}

function parseMagnet(uri: string): ParsedSource {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    // Some magnets contain characters URL() rejects; fall back to manual parsing.
    parsed = null as unknown as URL;
  }

  const params = new URLSearchParams(parsed ? parsed.search : uri.slice('magnet:'.length));
  const xts = params.getAll('xt').flatMap((v) => v.split('&'));
  let infoHashV1: string | undefined;
  let infoHashV2: string | undefined;

  for (const rawXt of xts) {
    const xt = decodeURIComponent(rawXt).trim();
    if (xt.toLowerCase().startsWith('urn:btih:')) {
      const value = xt.slice('urn:btih:'.length);
      if (BTIH_V1_HEX.test(value)) {
        infoHashV1 = value.toLowerCase();
      } else if (/^[a-zA-Z2-7]{32}$/.test(value)) {
        const hex = base32ToHex(value);
        if (hex && hex.length === 40) infoHashV1 = hex;
      }
    } else if (xt.toLowerCase().startsWith('urn:btmh:')) {
      const value = xt.slice('urn:btmh:'.length);
      // btmh is a multihash; accept 64-hex (blake3) payloads.
      if (BTMH_V2_HEX.test(value)) {
        infoHashV2 = value.toLowerCase();
      } else if (/^[a-zA-Z2-7]+$/.test(value)) {
        const hex = base32ToHex(value);
        if (hex && hex.length === 64) infoHashV2 = hex;
      }
    }
  }

  if (!infoHashV1 && !infoHashV2) {
    throw new InvalidTorrentSourceError(
      'Magnet URI has no usable btih/btmh infohash (xt parameter missing or malformed)',
      { source: uri },
    );
  }

  const dn = params.get('dn');
  return {
    kind: 'magnet',
    raw: uri,
    displayName: dn ? decodeURIComponent(dn) : undefined,
    infoHashV1,
    infoHashV2,
  };
}
