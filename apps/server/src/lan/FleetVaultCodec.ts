import { LanFleetError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FleetVaultRecord } from "./FleetAuthority.ts";

const decode = Schema.decodeSync(Schema.fromJsonString(FleetVaultRecord));
export const secretMarker = "T3F1:";
const secretPrefix = new TextEncoder().encode(secretMarker);

type CredentialReader = {
  readonly getSecret: () =>
    | ArrayLike<number>
    | null
    | undefined
    | Promise<ArrayLike<number> | null | undefined>;
  readonly getPassword: () => string | null | undefined | Promise<string | null | undefined>;
};

export const readFleetVaultRecord = (openEntry: () => CredentialReader) =>
  Effect.tryPromise({
    try: async () => {
      const entry = openEntry();
      const result = await entry.getSecret();
      // A missing entry is null on the synchronous store and undefined on the async store.
      if (result === undefined || result === null) return undefined;
      // Synchronous and asynchronous native bindings expose different byte containers.
      const raw = Uint8Array.from(result);
      if (
        raw.length >= secretPrefix.length &&
        secretPrefix.every((value, index) => raw[index] === value)
      )
        return decode(
          new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(secretPrefix.length)),
        );
      // Existing entries use the keyring's UTF-16 password encoding.
      const legacy = await entry.getPassword();
      if (legacy === undefined || legacy === null)
        throw new Error("Existing fleet credential cannot be decoded.");
      return decode(legacy);
    },
    catch: () => new LanFleetError({ reason: "configuration" }),
  });
