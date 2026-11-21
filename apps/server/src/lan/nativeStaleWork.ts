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
