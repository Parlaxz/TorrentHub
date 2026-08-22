import { describe, expect, it } from "vitest";
import {
  SECRET_MASK,
  assertNoPlaintextSecrets,
  secretDisplay,
} from "../../../src/renderer/server/domain/secrets";
import type { AppSettings } from "../../../src/renderer/server/bridge/types";

describe("secretDisplay", () => {
  it("unset secrets render empty", () => {
    expect(secretDisplay(false)).toEqual({ state: "unset", displayValue: "" });
  });

  it("saved secrets render the fixed mask, never plaintext", () => {
    const display = secretDisplay(true);
    expect(display.state).toBe("saved");
    expect(display.displayValue).toBe(SECRET_MASK);
    expect(display.displayValue).not.toMatch(/[a-zA-Z0-9]/);
  });

  it("revealed state requires explicitly passed plaintext", () => {
    expect(secretDisplay(true, "abc123").state).toBe("revealed");
    expect(secretDisplay(true, null).state).toBe("saved");
  });
});

describe("assertNoPlaintextSecrets", () => {
  const secretFields = ["qbitApiKey", "vikingUserHash"] as const;

  it("accepts display-safe objects (booleans/masks)", () => {
    const settingsLike: Record<string, unknown> = {
      qbitApiKeySet: true,
      vikingUserHash: SECRET_MASK,
    };
    expect(() => assertNoPlaintextSecrets(settingsLike, secretFields)).not.toThrow();
  });

  it("throws when plaintext leaks into a secret field", () => {
    const leaky: Record<string, unknown> = { qbitApiKey: "super-secret-key" };
    expect(() => assertNoPlaintextSecrets(leaky, secretFields)).toThrow(/leaked plaintext/i);
  });
});

describe("AppSettings contract shape", () => {
  it("carries only set-flags for secrets — structural guarantee against echo", () => {
    // Type-level intent made runtime-visible: any AppSettings object must be
    // safe to log because plaintext fields simply do not exist on it.
    const settings: AppSettings = {
      workingFolderPath: "D:\\VikingRelay",
      radminInterfaceId: null,
      relayPort: 47821,
      qbitWebUiUrl: "http://127.0.0.1:8080",
      qbitApiKeySet: true,
      vikingUserHashSet: false,
      startWithWindows: false,
      preventSleepDuringTransfers: true,
    };
    expect(Object.keys(settings)).not.toContain("qbitApiKey");
    expect(Object.keys(settings)).not.toContain("vikingUserHash");
    assertNoPlaintextSecrets(settings as unknown as Record<string, unknown>, [
      "qbitApiKey",
      "vikingUserHash",
    ]);
  });
});
