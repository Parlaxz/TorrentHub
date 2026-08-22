import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectIpv4Candidates,
  isBindableIpv4,
  selectAdapter,
  type InterfaceMap,
} from "../../src/main/relay/adapters.js";

function v4(address: string, internal = false) {
  return { address, family: "IPv4", internal };
}

function map(entries: Record<string, Parameters<typeof v4>[0][]>): InterfaceMap {
  const out: InterfaceMap = {};
  for (const [name, addrs] of Object.entries(entries)) {
    out[name] = addrs.map((a) => v4(a));
  }
  return out;
}

test("selects the Radmin adapter by name among other interfaces", () => {
  const result = selectAdapter(
    map({
      "Ethernet 2": ["192.168.1.10"],
      "Radmin VPN": ["26.10.40.7"],
      "Wi-Fi": ["10.0.0.5"],
    }),
  );
  assert.equal(result.reason, "adapter_name_match");
  assert.ok(result.selected);
  assert.equal(result.selected.adapterName, "Radmin VPN");
  assert.equal(result.selected.address, "26.10.40.7");
});

test("matches Famatech naming and configured preferred names", () => {
  const famatech = selectAdapter(map({ "Famatech VPN": ["26.1.1.1"] }));
  assert.equal(famatech.reason, "adapter_name_match");

  const preferred = selectAdapter(
    map({ "Ethernet 3": ["172.16.9.9"] }),
    { preferredAdapterNames: ["ethernet 3"] },
  );
  assert.equal(preferred.reason, "preferred_name");
  assert.equal(preferred.selected?.address, "172.16.9.9");
});

test("reports ambiguous when no name matches and several candidates exist", () => {
  const result = selectAdapter(
    map({ "Ethernet 2": ["192.168.1.10"], "Wi-Fi": ["10.0.0.5"] }),
  );
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.selected, null);
  assert.equal(result.candidates.length, 2);
});

test("single_candidate only when explicitly allowed", () => {
  const single = map({ "Ethernet 2": ["192.168.1.10"] });
  assert.equal(selectAdapter(single).reason, "ambiguous");
  const allowed = selectAdapter(single, { allowUnmatchedSingleAdapter: true });
  assert.equal(allowed.reason, "single_candidate");
  assert.equal(allowed.selected?.address, "192.168.1.10");
});

test("never selects 0.0.0.0 even when the adapter looks like Radmin", () => {
  const result = selectAdapter(map({ "Radmin VPN": ["0.0.0.0"] }));
  assert.equal(result.selected, null);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.reason, "none");

  const mixed = selectAdapter(
    map({ "Radmin VPN": ["0.0.0.0"], "Radmin VPN 2": ["26.5.5.5"] }),
  );
  assert.ok(mixed.selected);
  assert.notEqual(mixed.selected.address, "0.0.0.0");
});

test("excludes loopback and non-IPv4 entries", () => {
  const raw: InterfaceMap = {
    "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "Radmin VPN": [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "26.7.7.7", family: "IPv4", internal: false },
    ],
  };
  const result = selectAdapter(raw);
  assert.equal(result.selected?.address, "26.7.7.7");
  assert.equal(result.candidates.length, 1);
});

test("handles numeric family values from older typings", () => {
  assert.equal(
    isBindableIpv4({ address: "26.1.2.3", family: 4, internal: false }),
    true,
  );
  assert.equal(
    isBindableIpv4({ address: "::1", family: 6, internal: false }),
    false,
  );
});

test("override address must exist on a real interface", () => {
  const found = selectAdapter(map({ "Radmin VPN": ["26.1.1.1"] }), {
    overrideAddress: "26.1.1.1",
  });
  assert.equal(found.reason, "override");
  assert.equal(found.selected?.address, "26.1.1.1");

  const missing = selectAdapter(map({ "Radmin VPN": ["26.1.1.1"] }), {
    overrideAddress: "203.0.113.99",
  });
  assert.equal(missing.reason, "override_not_found");
  assert.equal(missing.selected, null);
});

test("collectIpv4Candidates sorts deterministically", () => {
  const candidates = collectIpv4Candidates(
    map({ "Wi-Fi": ["10.0.0.2", "10.0.0.1"], "Ethernet 2": ["192.168.0.1"] }),
  );
  assert.deepEqual(
    candidates.map((c) => `${c.adapterName}/${c.address}`),
    ["Ethernet 2/192.168.0.1", "Wi-Fi/10.0.0.1", "Wi-Fi/10.0.0.2"],
  );
});
