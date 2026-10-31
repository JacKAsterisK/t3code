import {
  type AuthEnvironmentScope,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  THREAD_OWNER_COMMAND_TYPE,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import { fleetCredentialScopes } from "../lan/FleetAccessPolicy.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("requires maintenance permission to issue or receive fleet pairing credentials", () => {
    for (const method of [
      WS_METHODS.serverSyncLanFleet,
      WS_METHODS.serverGetLanFleetSetup,
      WS_METHODS.serverConfigureLanFleet,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthEnvironmentMaintainScope);
  });
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("checks what an open connection may do at each call, not when it connected", () =>
    Effect.gen(function* () {
      let handled = 0;
      let current: ReadonlyArray<"settings:write" | "orchestration:read"> | undefined = [
        AuthSettingsWriteScope,
        AuthOrchestrationReadScope,
      ];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer(
              [AuthSettingsWriteScope, AuthOrchestrationReadScope],
              undefined,
              Effect.sync(() => current),
            ),
          ),
        ),
      );
      const update = client[WS_METHODS.serverUpdateSettings]({
        patch: { defaultRuntimeMode: "full-access" },
      });
      yield* update;
      expect(handled).toBe(1);
      // The fleet narrowed this connection's machine to read-only while it stayed open.
      current = [AuthOrchestrationReadScope];
      expect(yield* update.pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthSettingsWriteScope,
      });
      // A machine that left the fleet may do nothing.
      current = undefined;
      expect(yield* update.pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthSettingsWriteScope,
      });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers or secret providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread owner authorization", () => {
  const dispatch = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
  const readOnly = fleetCredentialScopes("read-only");
  const threadId = ThreadId.make("thread-owned");
  const ownerSet = {
    type: THREAD_OWNER_COMMAND_TYPE,
    commandId: CommandId.make("command-owner"),
    threadId,
    ownerId: "dan",
  } as const;
  const writes = [
    { type: "thread.pin", commandId: CommandId.make("command-pin"), threadId },
    { type: "thread.archive", commandId: CommandId.make("command-archive"), threadId },
    {
      type: "message.dispatch",
      commandId: CommandId.make("command-message"),
      threadId,
      messageId: MessageId.make("message-1"),
      createdBy: "user",
      creationSource: "web",
      text: "hello",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    },
  ] as const;

  // Widen the tuple to keep runtime enumeration independent of recursive type flattening.
  const commandMembers: ReadonlyArray<
    Schema.Constraint & { readonly Type: { readonly type: string } }
  > = OrchestrationV2Command.members;
  const commandTypes: ReadonlyArray<string> = Schema.Union(commandMembers).pipe(
    Schema.toTaggedUnion("type"),
  ).discriminants;

  it("lets read permission set an owner and nothing else a client can dispatch", () => {
    expect(readOnly).toEqual([
      AuthOrchestrationReadScope,
      AuthFilesystemReadScope,
      AuthDiagnosticsReadScope,
    ]);
    expect(commandTypes).toContain(THREAD_OWNER_COMMAND_TYPE);
    expect(commandTypes.length).toBeGreaterThan(50);
    for (const type of commandTypes) {
      const required = RpcAuthorization.requiredScopesForRpcCall(dispatch, {
        type,
        commandId: "command",
        threadId,
      });
      if (type === THREAD_OWNER_COMMAND_TYPE)
        expect(required, type).toEqual([AuthOrchestrationReadScope]);
      else expect(required, type).toContain(AuthOrchestrationOperateScope);
    }
    // The allowance is for that command on dispatch only, not a payload shaped like it elsewhere.
    expect(RpcAuthorization.requiredScopesForRpcCall(dispatch, undefined)).toContain(
      AuthOrchestrationOperateScope,
    );
    expect(
      RpcAuthorization.requiredScopesForRpcCall(ORCHESTRATION_V2_WS_METHODS.launchThread, ownerSet),
    ).not.toEqual([AuthOrchestrationReadScope]);
  });

  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof dispatch> => tag !== dispatch,
    ),
  );
  const client = (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    handled: Array<string>,
    currentScopes?: Effect.Effect<
      ReadonlyArray<AuthEnvironmentScope> | undefined,
      EnvironmentAuthorizationError
    >,
  ) =>
    RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(dispatch, (command) =>
            Effect.sync(() => {
              handled.push(command.type);
              return { sequence: handled.length };
            }),
          ),
          RpcAuthorization.layer(scopes, undefined, currentScopes),
        ),
      ),
    );

  it.effect("lets a read-only session set an owner but refuses its other writes", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const rpc = yield* client(readOnly, handled);
      yield* rpc[dispatch](ownerSet);
      for (const command of writes)
        expect(yield* rpc[dispatch](command).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });
      expect(handled).toEqual([THREAD_OWNER_COMMAND_TYPE]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an owner to a session that cannot read threads", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const rpc = yield* client([AuthFilesystemReadScope, AuthDiagnosticsReadScope], handled);
      expect(yield* rpc[dispatch](ownerSet).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("still lets a session the fleet narrows to read-only set an owner, and only that", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const standard = fleetCredentialScopes("standard");
      let current: ReadonlyArray<AuthEnvironmentScope> | undefined = standard;
      let unavailable = false;
      const rpc = yield* client(
        standard,
        handled,
        Effect.suspend(() =>
          unavailable
            ? Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "Current permissions are temporarily unavailable.",
                  requiredScope: AuthOrchestrationOperateScope,
                  retryable: true,
                }),
              )
            : Effect.succeed(current),
        ),
      );
      yield* rpc[dispatch](writes[0]);
      unavailable = true;
      expect(yield* rpc[dispatch](writes[0]).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        retryable: true,
      });
      expect(handled).toEqual(["thread.pin"]);
      unavailable = false;
      yield* rpc[dispatch](writes[0]);
      current = readOnly;
      yield* rpc[dispatch](ownerSet);
      for (const command of writes)
        expect(yield* rpc[dispatch](command).pipe(Effect.flip)).toMatchObject({
          requiredPermission: AuthOrchestrationOperateScope,
        });
      // A machine that left the fleet may not even set an owner.
      current = undefined;
      expect(yield* rpc[dispatch](ownerSet).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual(["thread.pin", "thread.pin", THREAD_OWNER_COMMAND_TYPE]);
    }).pipe(Effect.scoped),
  );
});
