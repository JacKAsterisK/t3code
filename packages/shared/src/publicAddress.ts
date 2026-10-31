// @effect-diagnostics nodeBuiltinImport:off -- Effect has no DNS resolver or address block list.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

/**
 * Classifies addresses an outbound request to a caller-chosen host must never reach: loopback,
 * private, link-local, CGNAT and tailnet, benchmarking, documentation, multicast and reserved
 * ranges, ULA, this machine's own interfaces, and IPv6 forms that carry any of those.
 * Used by the HTML preview proxy and by agent-event webhooks.
 */
const NON_PUBLIC = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
// Non-global IPv6 ranges, including IPv4 forms that translators may route without checking.
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001:2::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

const NAT64 = new NodeNet.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new NodeNet.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

const groupsToIPv4 = (high: number, low: number) =>
  [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");

// Check the carried IPv4 too: mapped (`::ffff:a.b.c.d`), NAT64 and 6to4. Public NAT64 targets
// stay reachable on IPv6-only networks.
const embeddedIPv4 = (address: string) => {
  const groups = ipv6Groups(address);
  if (
    groups.length === 8 &&
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  )
    return groupsToIPv4(groups[6]!, groups[7]!);
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  return groupsToIPv4(groups[at] ?? 0, groups[at + 1] ?? 0);
};

const ownAddresses = () => {
  const own = new NodeNet.BlockList();
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
};

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** True when `address` is anything but a public unicast address of another machine. */
export const isNonPublicAddress = (address: string, family: number): boolean => {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (NodeNet.isIP(address.split("%", 1)[0]!) !== family) return true;
  if (NON_PUBLIC.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isNonPublicAddress(embedded, 4);
};

/** Loopback only (127/8, ::1 and its mapped form): the dev harness exception, never LAN. */
export const isLoopbackAddress = (address: string, family: number): boolean => {
  if (family === 4) return address.startsWith("127.");
  const groups = ipv6Groups(address);
  if (groups.length !== 8) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  const embedded = embeddedIPv4(address);
  return embedded !== undefined && embedded.startsWith("127.");
};

const lookupAllAddresses = async (host: string): Promise<ReadonlyArray<ResolvedAddress>> =>
  NodeNet.isIP(host)
    ? [{ address: host, family: NodeNet.isIP(host) }]
    : await NodeDnsPromises.lookup(host, { all: true, verbatim: true }).catch(() => []);

/**
 * Resolves `host` once and returns its addresses only when every one is allowed, so a caller can
 * connect to exactly these (DNS rebinding cannot swap in another between check and connect).
 * Undefined when it does not resolve or any answer is refused.
 */
export const resolveAllowedAddresses = async (
  host: string,
  options: {
    readonly resolve?: (host: string) => Promise<ReadonlyArray<ResolvedAddress>>;
    readonly refuses?: (address: string, family: number) => boolean;
  } = {},
): Promise<ReadonlyArray<ResolvedAddress> | undefined> => {
  const addresses = await (options.resolve ?? lookupAllAddresses)(host).catch(() => []);
  if (addresses.length === 0) return undefined;
  const refuses = options.refuses ?? isNonPublicAddress;
  return addresses.some(({ address, family }) => refuses(address, family)) ? undefined : addresses;
};
