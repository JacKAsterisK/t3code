import { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const encode = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Number, Schema.Array(AuthEnvironmentScope), Schema.String]),
  ),
);

export const localAuthoritySnapshot = (authorization: {
  readonly enabled: number;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly runtimeModeCeiling: string;
}) =>
  encode([
    authorization.enabled,
    authorization.scopes.toSorted(),
    authorization.runtimeModeCeiling,
  ]);
