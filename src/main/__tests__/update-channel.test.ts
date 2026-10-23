import { describe, expect, it } from "vitest";
import { allowPrereleaseFor, feedFileFor } from "../update-channel";

describe("allowPrereleaseFor", () => {
  it("offers prereleases only to the beta channel", () => {
    expect(allowPrereleaseFor("beta")).toBe(true);
    expect(allowPrereleaseFor("stable")).toBe(false);
  });
});

describe("feedFileFor", () => {
  it("maps each channel to the feed file electron-updater requests", () => {
    expect(feedFileFor("stable")).toBe("stable.yml");
    expect(feedFileFor("beta")).toBe("beta.yml");
  });
});
