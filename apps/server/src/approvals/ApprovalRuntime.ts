import * as Administration from "./ApprovalAdministration.ts";
import * as SourceAuthority from "../auth/ApprovalAuthority.ts";
import * as Layer from "effect/Layer";
import * as Gate from "../auth/ApprovalAdmissionGate.ts";
import * as PeerAccess from "../auth/ApprovalPeerAccess.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as FleetAccess from "../lan/FleetAccessPolicy.ts";
import * as FleetApproval from "../lan/FleetApprovalPolicy.ts";
import * as FleetContext from "../lan/FleetContext.ts";
import * as FleetCredentials from "../lan/FleetCredentialAccess.ts";
import * as FleetVault from "../lan/FleetVault.ts";
import * as Delegations from "./ApprovalDelegations.ts";
import * as DestinationGuard from "./ApprovalDestinationGuard.ts";

const layerPeerSessions = PeerAccess.layer.pipe(
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(Gate.layer),
);
const layerCredentialAccess = FleetCredentials.layerServices.pipe(
  Layer.provideMerge(layerPeerSessions),
  Layer.provideMerge(FleetAccess.layer),
);
export const layerCap = FleetCredentials.layerCapServices.pipe(
  Layer.provideMerge(layerCredentialAccess),
);
export const layerDestination = DestinationGuard.layer.pipe(
  Layer.provideMerge(Delegations.layer),
  Layer.provideMerge(PeerAccess.layerDestination),
  Layer.provideMerge(layerCap),
);
const layerFleetPolicy = FleetApproval.layer.pipe(
  Layer.provideMerge(layerDestination),
  Layer.provideMerge(FleetContext.layer),
  Layer.provideMerge(FleetVault.layer),
);
export const layerBackground = Layer.mergeAll(
  FleetApproval.layerRefresh,
  FleetCredentials.layerRevocationServices,
).pipe(Layer.provide(layerFleetPolicy));

export const layerSourceAuthority = SourceAuthority.layer.pipe(Layer.provideMerge(layerCap));

export const layerAdministration = Administration.layer.pipe(Layer.provideMerge(layerFleetPolicy));
