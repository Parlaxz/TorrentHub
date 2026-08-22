import { PairingService, type PairAttemptResult, type PairingServiceOptions } from "./pairing.js";
import { TokenStore, type ClientMeta, type TokenPersistence } from "./tokenStore.js";

export interface AuthControllerOptions {
  tokens?: TokenStore;
  pairing?: PairingServiceOptions;
  persistence?: TokenPersistence;
}

export class AuthController {
  readonly tokens: TokenStore;
  readonly pairing: PairingService;

  constructor(options: AuthControllerOptions = {}) {
    this.tokens = options.tokens ?? new TokenStore(options.persistence);
    this.pairing = new PairingService(this.tokens, options.pairing ?? {});
  }

  beginPairing(): { code: string; expiresAt: number } {
    return this.pairing.beginPairing();
  }

  pairAttempt(code: string, ip: string, name?: string): PairAttemptResult {
    return this.pairing.attempt(code, ip, name);
  }

  authenticate(bearerToken: string): ClientMeta | null {
    return this.tokens.verify(bearerToken);
  }

  revokeClient(clientId: string): number {
    return this.tokens.revokeClient(clientId);
  }

  revokeAll(): number {
    return this.tokens.revokeAll();
  }

  listClients(): ClientMeta[] {
    return this.tokens.listClients();
  }
}
