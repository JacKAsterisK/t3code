// @effect-diagnostics nodeBuiltinImport:off -- Native write evidence requires the Node Writable completion callback.
import type * as NodeStream from "node:stream";

import * as Deferred from "effect/Deferred";
import * as NodeUtil from "node:util";

import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (
  handle: Pick<ChildProcessSpawner.ChildProcessHandle, "stdin" | "stdout">,
  stderrDrained: Effect.Effect<void>,
) =>
  Stdio.make({
    args: Effect.succeed([]),
    // Finish stderr separately from the protocol's exit-status deadline.
    stdin: handle.stdout.pipe(Stream.onEnd(stderrDrained)),
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

const STDERR_TAIL_MAX_CHARS = 8_192;
const STDERR_EXCERPT_MAX_CHARS = 512;
// `Error: …`, `TypeError: …`, `Error [ERR_MODULE_NOT_FOUND]: …`, `error: …`, `ERROR: …`, `fatal: …`
const ERROR_LINE_PATTERN = /^(?:[a-z]*error|fatal)(?: ?\[[^\]]+\])?:\s*\S/i;

export const appendStderrTail = (current: string, chunk: string): string => {
  const next = `${current}${chunk}`;
  return next.length <= STDERR_TAIL_MAX_CHARS ? next : next.slice(-STDERR_TAIL_MAX_CHARS);
};

// Node launchers print the actionable error between a source excerpt and stack frames.
export const stderrExcerpt = (tail: string): string | undefined => {
  const lines = NodeUtil.stripVTControlCharacters(tail)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  const line = lines.findLast((candidate) => ERROR_LINE_PATTERN.test(candidate)) ?? lines.at(-1);
  if (line === undefined) {
    return undefined;
  }
  return line.length <= STDERR_EXCERPT_MAX_CHARS
    ? line
    : `${line.slice(0, STDERR_EXCERPT_MAX_CHARS - 1)}…`;
};

export const makeStderrTail = Effect.fn("makeStderrTail")(function* (
  stderr: ChildProcessSpawner.ChildProcessHandle["stderr"],
) {
  const tail = yield* Ref.make("");
  const drain = yield* stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(tail, (current) => appendStderrTail(current, chunk))),
    Effect.ignore,
    Effect.forkScoped,
  );
  return {
    read: Ref.get(tail),
    awaitDrained: Fiber.join(drain).pipe(Effect.timeout("250 millis"), Effect.ignore),
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  stderrTail: Effect.Effect<string>,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.matchEffect(handle.exitCode, {
    onFailure: (cause) =>
      Effect.succeed(
        new CodexError.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          pid: handle.pid,
          cause,
        }),
      ),
    onSuccess: (code) =>
      Effect.map(stderrTail, (tail) => {
        const stderr = stderrExcerpt(tail);
        return new CodexError.CodexAppServerProcessExitedError({
          code,
          pid: handle.pid,
          ...(stderr ? { stderr } : {}),
        });
      }),
  });

export interface NativeWriteResult {
  readonly commandId: string;
  readonly state: "response_written" | "delivery_failed" | "delivery_unknown";
  readonly boundary: "node_write_callback" | "not_started" | "write_interrupted";
}

export interface AcknowledgedWriter {
  readonly write: (
    commandId: string,
    message: string,
    deduplicate?: boolean,
  ) => Effect.Effect<NativeWriteResult>;
}

export const makeAcknowledgedWriter = Effect.fn("CodexNativeWriter.make")(function* (
  writable: NodeStream.Writable,
) {
  let failedWriter = false;
  const markFailed = () => {
    failedWriter = true;
  };
  writable.on("error", markFailed);
  writable.once("close", () => writable.off("error", markFailed));
  type WriteEntry = {
    readonly commandId: string;
    readonly message: string;
    readonly done: Deferred.Deferred<NativeWriteResult>;
    cancelled: boolean;
    started: boolean;
  };
  const completedOrPending = new Map<string, WriteEntry>();
  const writes = yield* Queue.unbounded<WriteEntry>();
  // The worker, rather than the caller, owns the callback wait and message ordering.
  yield* Stream.fromQueue(writes).pipe(
    Stream.runForEach(
      Effect.fn("CodexNativeWriter.write")(function* (entry) {
        if (entry.cancelled || failedWriter || writable.destroyed || writable.writableEnded) {
          yield* Deferred.succeed(entry.done, {
            commandId: entry.commandId,
            state: "delivery_failed" as const,
            boundary: "not_started" as const,
          });
          return;
        }
        const result = yield* Effect.callback<NativeWriteResult>((resume) => {
          entry.started = true;
          let settled = false;
          const finish = (state: NativeWriteResult["state"]) => {
            if (settled) return;
            settled = true;
            if (state !== "response_written") failedWriter = true;
            writable.off("error", failed);
            writable.off("close", closed);
            resume(
              Effect.succeed({
                commandId: entry.commandId,
                state,
                boundary: "node_write_callback",
              }),
            );
          };
          const failed = () => finish("delivery_unknown");
          const closed = () => finish("delivery_unknown");
          writable.once("error", failed);
          writable.once("close", closed);
          try {
            writable.write(entry.message, (error) =>
              finish(error ? "delivery_unknown" : "response_written"),
            );
          } catch {
            finish("delivery_unknown");
          }
          return Effect.sync(() => {
            writable.off("error", failed);
            writable.off("close", closed);
          });
        }).pipe(
          Effect.onInterrupt(() =>
            Deferred.succeed(entry.done, {
              commandId: entry.commandId,
              state: "delivery_unknown" as const,
              boundary: "write_interrupted" as const,
            }),
          ),
        );
        yield* Deferred.succeed(entry.done, result);
      }),
    ),
    Effect.forkScoped,
  );
  return {
    write: Effect.fn("CodexNativeWriter.submit")(function* (
      commandId: string,
      message: string,
      deduplicate = true,
    ) {
      const previous = deduplicate ? completedOrPending.get(commandId) : undefined;
      if (previous !== undefined)
        return previous.message === message
          ? yield* Deferred.await(previous.done)
          : { commandId, state: "delivery_failed" as const, boundary: "not_started" as const };
      const done = yield* Deferred.make<NativeWriteResult>();
      const entry = { commandId, message, done, cancelled: false, started: false };
      if (deduplicate) completedOrPending.set(commandId, entry);
      yield* Queue.offer(writes, entry);
      return yield* Deferred.await(done).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            entry.cancelled = true;
            yield* Deferred.succeed(done, {
              commandId,
              state: entry.started ? ("delivery_unknown" as const) : ("delivery_failed" as const),
              boundary: entry.started ? ("write_interrupted" as const) : ("not_started" as const),
            });
          }),
        ),
      );
    }),
  } satisfies AcknowledgedWriter;
});
