import { describe, expect, it } from "vitest";

import { isLoopbackAddress, isNonPublicAddress, resolveAllowedAddresses } from "./publicAddress.ts";

describe("isNonPublicAddress", () => {
  it.each([
    ["127.0.0.1", 4],
    ["10.1.2.3", 4],
    ["172.16.0.1", 4],
    ["192.168.1.1", 4],
    ["169.254.169.254", 4],
    ["100.64.0.1", 4],
    ["100.100.100.100", 4],
    ["0.0.0.0", 4],
    ["224.0.0.1", 4],
    ["255.255.255.255", 4],
    ["198.18.0.1", 4],
    ["192.0.2.1", 4],
    ["203.0.113.9", 4],
    ["::1", 6],
    ["::", 6],
    ["fe80::1", 6],
    ["fc00::1", 6],
    ["fd12:3456::1", 6],
    ["ff02::1", 6],
    ["2001:db8::1", 6],
    // IPv4 carried in IPv6: mapped (both spellings), compatible, NAT64 and 6to4 of private hosts.
    ["::ffff:127.0.0.1", 6],
    ["::ffff:7f00:1", 6],
    ["::ffff:10.0.0.1", 6],
    ["::ffff:a9fe:a9fe", 6],
    ["::127.0.0.1", 6],
    ["64:ff9b::10.0.0.1", 6],
    ["64:ff9b::a00:1", 6],
    ["2002:0a00:0001::1", 6],
    ["2002:c0a8:0101::", 6],
  ] as const)("refuses %s", (address, family) => {
    expect(isNonPublicAddress(address, family)).toBe(true);
  });

  it.each([
    ["8.8.8.8", 4],
    ["1.1.1.1", 4],
    ["2606:4700:4700::1111", 6],
    // Public IPv4 through NAT64 and mapped forms stays reachable.
    ["64:ff9b::8.8.8.8", 6],
    ["::ffff:8.8.8.8", 6],
  ] as const)("allows %s", (address, family) => {
    expect(isNonPublicAddress(address, family)).toBe(false);
  });

  it("refuses an address whose family does not match", () => {
    expect(isNonPublicAddress("8.8.8.8", 6)).toBe(true);
    expect(isNonPublicAddress("not-an-address", 4)).toBe(true);
  });

  it("recognises loopback only for the dev harness", () => {
    expect(isLoopbackAddress("127.0.0.1", 4)).toBe(true);
    expect(isLoopbackAddress("::1", 6)).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isLoopbackAddress("10.0.0.1", 4)).toBe(false);
    expect(isLoopbackAddress("fe80::1", 6)).toBe(false);
  });
});

describe("resolveAllowedAddresses", () => {
  const resolving =
    (answers: ReadonlyArray<{ address: string; family: number }>) => async (_host: string) =>
      answers;

  it("returns every answer when all are public", async () => {
    const answers = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    expect(await resolveAllowedAddresses("example.test", { resolve: resolving(answers) })).toEqual(
      answers,
    );
  });

  it("refuses the host when any answer is private, so a mixed answer cannot be raced", async () => {
    expect(
      await resolveAllowedAddresses("example.test", {
        resolve: resolving([
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
      }),
    ).toBeUndefined();
    expect(
      await resolveAllowedAddresses("example.test", {
        resolve: resolving([
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "::ffff:192.168.0.1", family: 6 },
        ]),
      }),
    ).toBeUndefined();
  });

  it("refuses a host that does not resolve or fails to", async () => {
    expect(
      await resolveAllowedAddresses("example.test", { resolve: resolving([]) }),
    ).toBeUndefined();
    expect(
      await resolveAllowedAddresses("example.test", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).toBeUndefined();
  });

  it("checks a literal address without resolving it", async () => {
    expect(await resolveAllowedAddresses("127.0.0.1")).toBeUndefined();
    expect(await resolveAllowedAddresses("8.8.8.8")).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });
});
