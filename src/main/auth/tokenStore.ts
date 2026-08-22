import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ClientMeta {
  clientId: string;
  name: string;
  createdAt: string;
  revoked: boolean;
}

export interface StoredToken extends ClientMeta {
  tokenId: string;
}

export interface TokenPersistence {
  load(): StoredToken[] | null;
  save(tokens: StoredToken[]): void;
}

export interface IssuedToken {
  clientId: string;
  name: string;
  token: string;
}

export function hmacTokenId(token: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

const TOKEN_ID_HEX_LENGTH = 64;

export class TokenStore {
  private readonly secret: Buffer;
  private readonly byTokenId = new Map<string, StoredToken>();
  private readonly persistence?: TokenPersistence;

  constructor(persistence?: TokenPersistence, secret?: Buffer) {
    this.secret = secret ?? randomBytes(32);
    this.persistence = persistence;
    const restored = persistence?.load() ?? null;
    if (restored) {
      for (const rec of restored) {
        if (rec && typeof rec.tokenId === "string" && rec.tokenId.length === TOKEN_ID_HEX_LENGTH) {
          this.byTokenId.set(rec.tokenId, { ...rec });
        }
      }
    }
  }

  issue(name: string): IssuedToken {
    const token = randomBytes(32).toString("base64url");
    const clientId = `vrc_${randomBytes(8).toString("hex")}`;
    const rec: StoredToken = {
      tokenId: hmacTokenId(token, this.secret),
      clientId,
      name,
      createdAt: new Date().toISOString(),
      revoked: false,
    };
    this.byTokenId.set(rec.tokenId, rec);
    this.persist();
    return { clientId, name, token };
  }

  verify(token: string): ClientMeta | null {
    if (typeof token !== "string" || token.length < 20 || token.length > 512) return null;
    const digestHex = hmacTokenId(token, this.secret);
    const digest = Buffer.from(digestHex, "hex");
    for (const rec of this.byTokenId.values()) {
      if (rec.tokenId.length !== TOKEN_ID_HEX_LENGTH) continue;
      const candidate = Buffer.from(rec.tokenId, "hex");
      if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) {
        if (rec.revoked) return null;
        return {
          clientId: rec.clientId,
          name: rec.name,
          createdAt: rec.createdAt,
          revoked: rec.revoked,
        };
      }
    }
    return null;
  }

  revokeClient(clientId: string): number {
    let count = 0;
    for (const rec of this.byTokenId.values()) {
      if (rec.clientId === clientId && !rec.revoked) {
        rec.revoked = true;
        count++;
      }
    }
    if (count > 0) this.persist();
    return count;
  }

  revokeAll(): number {
    let count = 0;
    for (const rec of this.byTokenId.values()) {
      if (!rec.revoked) {
        rec.revoked = true;
        count++;
      }
    }
    if (count > 0) this.persist();
    return count;
  }

  listClients(): ClientMeta[] {
    const latest = new Map<string, ClientMeta>();
    for (const rec of this.byTokenId.values()) {
      latest.set(rec.clientId, {
        clientId: rec.clientId,
        name: rec.name,
        createdAt: rec.createdAt,
        revoked: rec.revoked,
      });
    }
    return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  digest(): StoredToken[] {
    return [...this.byTokenId.values()].map((rec) => ({ ...rec }));
  }

  restore(records: StoredToken[]): void {
    this.byTokenId.clear();
    for (const rec of records) {
      if (rec && typeof rec.tokenId === "string" && rec.tokenId.length === TOKEN_ID_HEX_LENGTH) {
        this.byTokenId.set(rec.tokenId, { ...rec });
      }
    }
    this.persist();
  }

  private persist(): void {
    this.persistence?.save(this.digest());
  }
}
