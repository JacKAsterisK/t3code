import type * as NodeSqlite from "node:sqlite";

type WorkRow = Record<string, NodeSqlite.SQLOutputValue>;

function nodeLinkMatches(
  row: WorkRow,
  node: WorkRow,
  value: Record<string, unknown>,
  requestId: unknown,
  allowMissingRequestColumn = false,
) {
  return {
    columnThread: node.thread_id === row.thread_id,
    payloadId: value.id === node.node_id,
    payloadThread: value.threadId === node.thread_id,
    payloadRun: value.runId === node.run_id,
    payloadRequest:
      (value.runtimeRequestId ?? null) === node.runtime_request_id ||
      (allowMissingRequestColumn &&
        node.runtime_request_id === null &&
        value.runtimeRequestId === requestId),
    columnRequest: node.runtime_request_id === null || node.runtime_request_id === requestId,
    columnRun: row.run_id === null || node.run_id === null || row.run_id === node.run_id,
  };
}

export function describeStaleApprovalLinks(
  db: NodeSqlite.DatabaseSync,
  readPayload: (row: WorkRow) => Record<string, unknown>,
  now: number,
) {
  const isStale = staleApprovalClassifier(db, readPayload, now);
  const nodeById = db.prepare("SELECT * FROM orchestration_v2_projection_nodes WHERE node_id=?");
  const approvals = db.prepare(`SELECT * FROM orchestration_v2_projection_turn_items
    WHERE type='approval_request' AND status='waiting' ORDER BY updated_at LIMIT 20`);
  return approvals.all().map((row) => {
    const value = readPayload(row);
    const node = typeof row.node_id === "string" ? nodeById.get(row.node_id) : undefined;
    return {
      classifiedStale: isStale(row, value),
      nodePresent: node !== undefined,
      nodeLinks:
        node === undefined ? null : nodeLinkMatches(row, node, readPayload(node), value.requestId),
    };
  });
}

const freshnessMs = 24 * 60 * 60 * 1000;
const terminalRunStatuses = ["completed", "interrupted", "failed", "cancelled", "rolled_back"];
const terminalDeliveries = ["provider_acknowledged", "refused", "delivery_withheld"];
const isTerminalDelivery = (state: unknown): state is string =>
  typeof state === "string" && terminalDeliveries.includes(state);

function timestampBefore(value: unknown, cutoff: number): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/u.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis < cutoff;
}

export function staleApprovalClassifier(
  db: NodeSqlite.DatabaseSync,
  readPayload: (row: WorkRow) => Record<string, unknown>,
  now: number,
) {
  const runById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_runs WHERE run_id=? AND thread_id=?",
  );
  const latestRun = db.prepare(
    "SELECT * FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1",
  );
  const busyRun = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=? AND status NOT IN ('completed','interrupted','failed','cancelled','rolled_back') LIMIT 1",
  );
  const pendingRequest = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=? AND status='pending' LIMIT 1",
  );
  const requestById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?",
  );
  const nodeById = db.prepare("SELECT * FROM orchestration_v2_projection_nodes WHERE node_id=?");
  const receiptsByRequest = db.prepare(
    "SELECT thread_id, state FROM agent_approval_receipts WHERE request_id=?",
  );
  const receiptById = db.prepare(
    "SELECT request_id, thread_id, state FROM agent_approval_receipts WHERE receipt_id=?",
  );
  const isTerminalRun = (run: WorkRow | undefined): run is WorkRow => {
    if (
      run === undefined ||
      !terminalRunStatuses.includes(String(run.status)) ||
      !timestampBefore(run.completed_at, now + 1)
    )
      return false;
    const value = readPayload(run);
    return (
      value.id === run.run_id &&
      value.threadId === run.thread_id &&
      value.status === run.status &&
      value.completedAt === run.completed_at
    );
  };

  // The approval item is display state. Only its request or delivery can execute.
  return (row: WorkRow, value: Record<string, unknown>): boolean => {
    const threadId = row.thread_id;
    if (
      row.type !== "approval_request" ||
      row.status !== "waiting" ||
      typeof threadId !== "string" ||
      typeof row.turn_item_id !== "string" ||
      value.id !== row.turn_item_id ||
      value.threadId !== threadId ||
      value.type !== row.type ||
      value.status !== row.status ||
      value.runId !== row.run_id ||
      (value.nodeId ?? null) !== row.node_id ||
      typeof value.requestId !== "string" ||
      value.requestId.length === 0 ||
      value.updatedAt !== row.updated_at ||
      !timestampBefore(row.updated_at, now - freshnessMs) ||
      (value.approvalDelivery !== undefined && !isTerminalDelivery(value.approvalDelivery)) ||
      busyRun.get(threadId) ||
      pendingRequest.get(threadId)
    )
      return false;

    const receipts = receiptsByRequest.all(value.requestId);
    if (
      receipts.some(
        (receipt) => receipt.thread_id !== threadId || !isTerminalDelivery(receipt.state),
      )
    )
      return false;

    let cancelledWithoutDelivery = false;
    const request = requestById.get(value.requestId);
    if (request !== undefined) {
      const requestValue = readPayload(request);
      const delivery = requestValue.approvalDelivery;
      const receiptId = requestValue.approvalReceiptId;
      let linkedReceiptSettled = false;
      if (receiptId !== undefined) {
        if (typeof receiptId !== "string" || receiptId.length === 0) return false;
        const receipt = receiptById.get(receiptId);
        if (
          receipt === undefined ||
          receipt.request_id !== value.requestId ||
          receipt.thread_id !== threadId ||
          !isTerminalDelivery(receipt.state) ||
          (delivery !== undefined && delivery !== receipt.state)
        )
          return false;
        linkedReceiptSettled = true;
      }
      if (
        !["resolved", "cancelled", "expired"].includes(String(request.status)) ||
        request.thread_id !== threadId ||
        request.node_id !== row.node_id ||
        requestValue.id !== value.requestId ||
        requestValue.status !== request.status ||
        requestValue.nodeId !== request.node_id ||
        (delivery !== undefined && !isTerminalDelivery(delivery)) ||
        (request.status === "resolved" && !isTerminalDelivery(delivery) && !linkedReceiptSettled)
      )
        return false;
      cancelledWithoutDelivery =
        request.status === "cancelled" &&
        typeof row.provider_turn_id === "string" &&
        value.providerTurnId === row.provider_turn_id &&
        request.provider_turn_id === row.provider_turn_id &&
        requestValue.providerTurnId === row.provider_turn_id &&
        value.approvalDelivery === undefined &&
        delivery === undefined &&
        receiptId === undefined &&
        receipts.length === 0;
    }

    const node = typeof row.node_id === "string" ? nodeById.get(row.node_id) : undefined;
    if (node !== undefined) {
      const nodeValue = readPayload(node);
      // The node projection writer stores runtimeRequestId in the payload and
      // can leave its nullable SQL column empty. Only accept that omission with
      // an exact cancelled request, the same run on both sides and a terminal node.
      const allowMissingRequestColumn =
        cancelledWithoutDelivery &&
        typeof row.run_id === "string" &&
        row.run_id === node.run_id &&
        node.provider_turn_id === row.provider_turn_id &&
        nodeValue.providerTurnId === row.provider_turn_id &&
        typeof row.provider_thread_id === "string" &&
        value.providerThreadId === row.provider_thread_id &&
        node.provider_thread_id === row.provider_thread_id &&
        nodeValue.providerThreadId === row.provider_thread_id &&
        nodeValue.status === node.status &&
        terminalRunStatuses.includes(String(node.status));
      const links = nodeLinkMatches(
        row,
        node,
        nodeValue,
        value.requestId,
        allowMissingRequestColumn,
      );
      if (!Object.values(links).every(Boolean)) return false;
    }
    const parentId = row.run_id ?? node?.run_id;
    const parent =
      parentId == null
        ? latestRun.get(threadId)
        : typeof parentId === "string"
          ? runById.get(parentId, threadId)
          : undefined;
    return isTerminalRun(parent);
  };
}

// Stopped admission proves there is no T3 server. These matches additionally
// require an old terminal run and positive linkage for its leftover native rows.
export function staleNativeProjectionClassifier(db: NodeSqlite.DatabaseSync, now: number) {
  const runById = db.prepare("SELECT * FROM orchestration_v2_projection_runs WHERE run_id=?");
  const nodeById = db.prepare("SELECT * FROM orchestration_v2_projection_nodes WHERE node_id=?");
  const active = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=? AND (status IS NULL OR status NOT IN ('completed','interrupted','failed','cancelled','rolled_back')) LIMIT 1",
  );
  const pending = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id=? AND status='pending' LIMIT 1",
  );
  const runtime = db.prepare(
    "SELECT 1 FROM provider_session_runtime WHERE thread_id=? AND status NOT IN ('stopped','error') LIMIT 1",
  );
  const busySession = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_provider_sessions s WHERE (s.thread_id=? OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_session_bindings b WHERE b.provider_session_id=s.provider_session_id AND b.thread_id=?) OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads t WHERE t.provider_session_id=s.provider_session_id AND t.thread_id=?)) AND (s.status IS NULL OR s.status NOT IN ('ready','stopped','error')) LIMIT 1",
  );
  const providerThreadById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?",
  );
  const sessionById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id=?",
  );
  const providerTurnById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?",
  );
  const unsettledTurnAtNode = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE node_id=? AND provider_turn_id<>? AND (status IS NULL OR status NOT IN ('completed','interrupted','failed','cancelled')) LIMIT 1",
  );
  const requestAtNode = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE node_id=? AND status='pending' LIMIT 1",
  );
  const subagentById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_subagents WHERE subagent_id=?",
  );
  const attemptById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_run_attempts WHERE attempt_id=?",
  );
  const liveGoal = db.prepare(
    "SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE thread_id=? AND (json_extract(payload_json,'$.goal.status')='active' OR json_array_length(payload_json,'$.pendingBackgroundTasks')>0) LIMIT 1",
  );
  const old = (value: unknown) => timestampBefore(value, now - freshnessMs);
  const payload = (row: WorkRow) => {
    if (typeof row.payload_json !== "string") return undefined;
    const value = JSON.parse(row.payload_json);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };
  const isNativeNodeChain = (nodeId: string, threadId: string, runId: string) => {
    const seen = new Set<string>();
    let current: string | null = nodeId;
    while (current !== null) {
      if (seen.has(current)) return false;
      seen.add(current);
      const task = subagentById.get(current);
      if (
        task !== undefined &&
        (task.origin !== "provider_native" || payload(task)?.origin !== "provider_native")
      )
        return false;
      const node: WorkRow | undefined = nodeById.get(current);
      if (node?.thread_id !== threadId || node.run_id !== runId) return false;
      const value = payload(node);
      if (
        value?.id !== current ||
        value.threadId !== threadId ||
        value.runId !== runId ||
        (node.parent_node_id !== null && typeof node.parent_node_id !== "string") ||
        (value.parentNodeId ?? null) !== node.parent_node_id
      )
        return false;
      current = node.parent_node_id;
    }
    return true;
  };
  const ownNode = (nodeId: unknown, threadId: string, runId: string) => {
    if (typeof nodeId !== "string") return false;
    const node = nodeById.get(nodeId);
    if (node === undefined) return false;
    const value = payload(node);
    return (
      value?.id === nodeId &&
      value.threadId === threadId &&
      value.runId === runId &&
      node.thread_id === threadId &&
      node.run_id === runId &&
      value.status === node.status &&
      node.runtime_request_id === null &&
      value.runtimeRequestId === null &&
      !requestAtNode.get(nodeId) &&
      isNativeNodeChain(nodeId, threadId, runId)
    );
  };
  return (table: string, row: WorkRow) => {
    if (
      ![
        "orchestration_v2_projection_nodes",
        "orchestration_v2_projection_turn_items",
        "orchestration_v2_projection_subagents",
        "orchestration_v2_projection_run_attempts",
        "orchestration_v2_projection_provider_turns",
      ].includes(table)
    )
      return false;
    const threadId = row.thread_id;
    if (typeof threadId !== "string") return false;
    const value = payload(row);
    const providerTurn = table === "orchestration_v2_projection_provider_turns";
    const runAttempt = table === "orchestration_v2_projection_run_attempts";
    if (
      value === undefined ||
      (!providerTurn && !runAttempt && value.threadId !== threadId) ||
      value.status !== row.status ||
      !old(row.updated_at ?? value.updatedAt ?? row.started_at ?? value.startedAt)
    )
      return false;
    const runId =
      providerTurn && typeof row.node_id === "string"
        ? nodeById.get(row.node_id)?.run_id
        : row.run_id;
    if (typeof runId !== "string" || (!providerTurn && value.runId !== runId)) return false;
    const run = runById.get(runId);
    if (
      run === undefined ||
      run.thread_id !== threadId ||
      !terminalRunStatuses.includes(String(run.status))
    )
      return false;
    const runValue = payload(run);
    if (
      runValue?.id !== runId ||
      runValue.threadId !== threadId ||
      runValue.status !== run.status ||
      !old(run.completed_at ?? runValue.completedAt)
    )
      return false;
    if (
      active.get(threadId) ||
      pending.get(threadId) ||
      runtime.get(threadId) ||
      busySession.get(threadId, threadId, threadId) ||
      liveGoal.get(threadId)
    )
      return false;
    if (
      row.provider_thread_id !== undefined &&
      (value.providerThreadId ?? null) !== row.provider_thread_id
    )
      return false;
    if (typeof row.provider_thread_id === "string") {
      const providerThread = providerThreadById.get(row.provider_thread_id);
      if (
        providerThread?.thread_id !== threadId ||
        !["idle", "not_loaded", "archived", "closed", "error"].includes(
          String(providerThread.status),
        )
      )
        return false;
      const threadValue = payload(providerThread);
      if (
        threadValue?.id !== row.provider_thread_id ||
        threadValue.status !== providerThread.status ||
        threadValue.appThreadId !== threadId ||
        threadValue.providerSessionId !== providerThread.provider_session_id ||
        value.providerThreadId !== row.provider_thread_id
      )
        return false;
      if (typeof providerThread.provider_session_id !== "string") return false;
      const session = sessionById.get(providerThread.provider_session_id);
      if (session === undefined || !["stopped", "error"].includes(String(session.status)))
        return false;
      const sessionValue = payload(session);
      if (
        sessionValue?.id !== providerThread.provider_session_id ||
        sessionValue.status !== session.status
      )
        return false;
    }
    if (
      !providerTurn &&
      row.provider_turn_id !== undefined &&
      (value.providerTurnId ?? null) !== row.provider_turn_id
    )
      return false;
    if (!providerTurn && typeof row.provider_turn_id === "string") {
      const turn = providerTurnById.get(row.provider_turn_id);
      if (
        turn?.thread_id !== threadId ||
        !terminalRunStatuses.includes(String(turn.status)) ||
        payload(turn)?.status !== turn.status ||
        value.providerTurnId !== row.provider_turn_id
      )
        return false;
    }
    if (
      typeof row.node_id === "string" &&
      unsettledTurnAtNode.get(row.node_id, providerTurn ? row.provider_turn_id! : "")
    )
      return false;
    switch (table) {
      case "orchestration_v2_projection_nodes":
        return ownNode(row.node_id, threadId, runId);
      case "orchestration_v2_projection_turn_items":
        return (
          value.id === row.turn_item_id &&
          value.type === row.type &&
          (row.type !== "subagent" || value.origin === "provider_native") &&
          value.nodeId === row.node_id &&
          !["approval_request", "secret_request", "link_request", "user_input_request"].includes(
            String(row.type),
          ) &&
          ownNode(row.node_id, threadId, runId)
        );
      case "orchestration_v2_projection_subagents":
        return (
          value.id === row.subagent_id &&
          value.origin === "provider_native" &&
          row.origin === "provider_native" &&
          value.remoteChild == null &&
          value.completionDelivery == null &&
          value.childThreadId === null &&
          row.child_thread_id === null &&
          ownNode(value.parentNodeId, threadId, runId)
        );
      case "orchestration_v2_projection_run_attempts":
        return value.id === row.attempt_id && ownNode(value.rootNodeId, threadId, runId);
      default: {
        if (
          value.id !== row.provider_turn_id ||
          value.nodeId !== row.node_id ||
          value.runAttemptId !== row.run_attempt_id ||
          !ownNode(row.node_id, threadId, runId)
        )
          return false;
        if (row.run_attempt_id === null) return true;
        if (typeof row.run_attempt_id !== "string") return false;
        const attempt = attemptById.get(row.run_attempt_id);
        if (attempt === undefined) return false;
        const attemptValue = payload(attempt);
        return (
          attempt.thread_id === threadId &&
          attempt.run_id === runId &&
          attemptValue?.id === row.run_attempt_id &&
          attemptValue.runId === runId &&
          attemptValue.status === attempt.status &&
          ["completed", "interrupted", "failed", "cancelled", "superseded"].includes(
            String(attempt.status),
          )
        );
      }
    }
  };
}

// An interrupted provider callback can become a question answered by sending a
// new message. Carry its card with that request when all projection links agree.
export function carriedMessageInputClassifier(
  db: NodeSqlite.DatabaseSync,
  payload: (row: WorkRow) => Record<string, unknown>,
  requests: ReadonlyMap<unknown, WorkRow>,
) {
  const runById = db.prepare("SELECT * FROM orchestration_v2_projection_runs WHERE run_id=?");
  const nodeById = db.prepare("SELECT * FROM orchestration_v2_projection_nodes WHERE node_id=?");
  const turnById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=?",
  );
  return (row: WorkRow, card: Record<string, unknown>) => {
    if (
      row.type !== "user_input_request" ||
      row.status !== "waiting" ||
      card.type !== row.type ||
      card.status !== row.status ||
      card.id !== row.turn_item_id ||
      card.threadId !== row.thread_id ||
      typeof row.run_id !== "string" ||
      card.runId !== row.run_id ||
      typeof row.node_id !== "string" ||
      card.nodeId !== row.node_id ||
      typeof row.provider_turn_id !== "string" ||
      card.providerTurnId !== row.provider_turn_id ||
      typeof row.provider_thread_id !== "string" ||
      card.providerThreadId !== row.provider_thread_id ||
      !Array.isArray(card.questions) ||
      card.questions.length === 0 ||
      !card.questions.every(
        (value) => typeof value?.question === "string" && value.question.trim().length > 0,
      )
    )
      return false;
    const request = requests.get(card.requestId);
    if (
      request === undefined ||
      request.kind !== "user_input" ||
      request.status !== "pending" ||
      request.thread_id !== row.thread_id ||
      request.node_id !== row.node_id ||
      request.provider_turn_id !== row.provider_turn_id
    )
      return false;
    const requestValue = payload(request);
    if (
      requestValue.kind !== request.kind ||
      requestValue.status !== request.status ||
      requestValue.id !== request.runtime_request_id ||
      requestValue.nodeId !== row.node_id ||
      requestValue.providerTurnId !== row.provider_turn_id
    )
      return false;
    const run = runById.get(row.run_id);
    if (run?.thread_id !== row.thread_id || run === undefined) return false;
    const runValue = payload(run);
    if (
      runValue.id !== row.run_id ||
      runValue.threadId !== row.thread_id ||
      runValue.status !== run.status
    )
      return false;
    const node = nodeById.get(row.node_id);
    if (
      node === undefined ||
      node.thread_id !== row.thread_id ||
      node.run_id !== row.run_id ||
      node.kind !== "user_input_request" ||
      (node.provider_thread_id !== null && node.provider_thread_id !== row.provider_thread_id) ||
      (node.provider_turn_id !== null && node.provider_turn_id !== row.provider_turn_id) ||
      (node.runtime_request_id !== null && node.runtime_request_id !== card.requestId)
    )
      return false;
    const nodeValue = payload(node);
    if (
      nodeValue.id !== row.node_id ||
      nodeValue.kind !== node.kind ||
      nodeValue.status !== node.status ||
      nodeValue.threadId !== row.thread_id ||
      nodeValue.runId !== row.run_id ||
      nodeValue.providerThreadId !== row.provider_thread_id ||
      nodeValue.providerTurnId !== row.provider_turn_id ||
      nodeValue.runtimeRequestId !== card.requestId
    )
      return false;
    const turn = turnById.get(row.provider_turn_id);
    if (
      turn === undefined ||
      turn.thread_id !== row.thread_id ||
      turn.provider_thread_id !== row.provider_thread_id
    )
      return false;
    const turnValue = payload(turn);
    return (
      turnValue.id === row.provider_turn_id &&
      turnValue.status === turn.status &&
      turnValue.providerThreadId === row.provider_thread_id
    );
  };
}

/** Legacy admission can carry orphan cards. Only mutate when their exact owners are present. */
export function staleApprovalMaySettle(db: NodeSqlite.DatabaseSync) {
  const requestById = db.prepare(
    "SELECT * FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id=?",
  );
  const nodeById = db.prepare("SELECT * FROM orchestration_v2_projection_nodes WHERE node_id=?");
  return (row: WorkRow) => {
    if (typeof row.payload_json !== "string" || typeof row.node_id !== "string") return false;
    const value = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (typeof value.requestId !== "string" || value.nodeId !== row.node_id) return false;
    const request = requestById.get(value.requestId);
    const node = nodeById.get(row.node_id);
    return (
      request?.thread_id === row.thread_id &&
      request?.node_id === row.node_id &&
      node?.thread_id === row.thread_id &&
      typeof node?.run_id === "string" &&
      (row.run_id === node.run_id || (row.run_id === null && value.runId === node.run_id))
    );
  };
}
