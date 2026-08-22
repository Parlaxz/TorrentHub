/**
 * safeStorage-backed persistence for A6's TokenStore.
 *
 * Persists the HMAC secret AND the stored token digests/metadata so paired
 * clients survive normal Viking Relay restarts. Raw permanent bearer tokens
 * are NEVER stored server-side — only their HMAC-SHA256 digests.
 *
 * This is authentication persistence, NOT transfer crash recovery.
 */
import { randomBytes } from 'node:crypto';
import type { TokenPersistence, StoredToken } from '../auth/tokenStore';
import type { SecretStore } from '../secrets';

const SECRET_KEY = 'auth.tokenSecret';
const DIGESTS_KEY = 'auth.tokens';

interface DigestFile {
  version: 1;
  tokens: StoredToken[];
}

export class SafeStorageTokenPersistence implements TokenPersistence {
  constructor(private readonly secrets: SecretStore) {}

  /** Ensures the HMAC secret exists; returns it as raw bytes. */
  ensureSecret(): Buffer {
    const existing = this.secrets.get(SECRET_KEY);
    if (existing) {
      return Buffer.from(existing, 'hex');
    }
    const secret = randomBytes(32);
    this.secrets.set(SECRET_KEY, secret.toString('hex'));
    return secret;
  }

  load(): StoredToken[] | null {
    const raw = this.secrets.get(DIGESTS_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as DigestFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) return null;
      return parsed.tokens.filter(
        (t): t is StoredToken =>
          !!t &&
          typeof t.tokenId === 'string' &&
          typeof t.clientId === 'string' &&
          typeof t.name === 'string' &&
          typeof t.createdAt === 'string' &&
          typeof t.revoked === 'boolean',
      );
    } catch {
      return null;
    }
  }

  save(tokens: StoredToken[]): void {
    const file: DigestFile = { version: 1, tokens };
    this.secrets.set(DIGESTS_KEY, JSON.stringify(file));
  }
}
