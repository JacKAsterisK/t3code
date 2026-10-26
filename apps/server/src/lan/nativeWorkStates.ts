// Shared metadata classifications. Native admission remains authoritative.
const terminal = ["completed", "interrupted", "failed", "cancelled", "rolled_back"];
const completed = ["completed", "interrupted", "failed", "cancelled"];
export const nativeWorkStatusDefinitions = [
  [
    "orchestration_v2_projection_runs",
    ["preparing", "queued", "starting", "running", "waiting", ...terminal],
    ["preparing", "starting", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_run_attempts",
    ["pending", "running", "superseded", ...completed],
    ["pending", "running"],
  ],
  [
    "orchestration_v2_projection_nodes",
    ["idle", "pending", "running", "waiting", ...terminal],
    ["pending", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    ["starting", "ready", "running", "waiting", "stopped", "error"],
    ["starting", "ready", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_provider_threads",
    ["not_loaded", "idle", "active", "archived", "closed", "error"],
    ["active"],
  ],
  [
    "orchestration_v2_projection_provider_turns",
    ["pending", "running", ...completed],
    ["pending", "running"],
  ],
  [
    "orchestration_v2_projection_runtime_requests",
    ["pending", "resolved", "expired", "cancelled"],
    ["pending"],
  ],
  [
    "orchestration_v2_projection_subagents",
    ["idle", "pending", "running", "waiting", ...completed],
    ["pending", "running", "waiting"],
  ],
  [
    "orchestration_v2_projection_turn_items",
    ["idle", "pending", "running", "waiting", ...completed],
    ["pending", "running", "waiting"],
  ],
  [
    "orchestration_v2_effect_outbox",
    ["pending", "running", "succeeded", "failed", "cancelled"],
    ["pending", "running"],
  ],
] as const;

const nativeWorkCategories = [
  "activeRuns",
  "queuedRuns",
  "pendingRequests",
  "backgroundAgents",
  "scheduledWork",
  "restartContinuations",
] as const;
type NativeWorkCategory = (typeof nativeWorkCategories)[number];
export const emptyNativeWork = (): Record<NativeWorkCategory, number> => ({
  activeRuns: 0,
  queuedRuns: 0,
  pendingRequests: 0,
  backgroundAgents: 0,
  scheduledWork: 0,
  restartContinuations: 0,
});

// Keep this fail-closed subset aligned with EffectOutbox's process-loss replay policy.
export const nativeRestartSafeEffects: Readonly<Record<string, ReadonlyArray<string>>> = {
  "provider-runtime.continue": ["sourceRunId"],
  "provider-session.detach": ["providerSessionId"],
  "provider-thread.rollback": ["providerThreadId", "checkpointId", "scopeId"],
  "checkpoint.capture": ["runId", "scopeId"],
  "scheduled-tasks.cleanup": [],
  "terminal.cleanup": [],
  "preview.cleanup": [],
  "attachment.cleanup": [],
  "thread-title.generate": [],
  "delegated-tasks.stop": [],
};
