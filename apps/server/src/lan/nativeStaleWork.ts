import type * as NodeSqlite from "node:sqlite";

type WorkRow = Record<string, NodeSqlite.SQLOutputValue>;

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
    }

    const node = typeof row.node_id === "string" ? nodeById.get(row.node_id) : undefined;
    if (node !== undefined) {
      const nodeValue = readPayload(node);
      if (
        node.thread_id !== threadId ||
        nodeValue.id !== node.node_id ||
        nodeValue.threadId !== node.thread_id ||
        nodeValue.runId !== node.run_id ||
        (nodeValue.runtimeRequestId ?? null) !== node.runtime_request_id ||
        (node.runtime_request_id !== null && node.runtime_request_id !== value.requestId) ||
        (row.run_id !== null && node.run_id !== null && row.run_id !== node.run_id)
      )
        return false;
    }
    const parentId = row.run_id ?? node?.run_id;
    const parent =
      parentId == null
        ? latestRun.get(threadId)
        : typeof parentId === "string"
          ? runById.get(parentId, threadId)
          : undefined;
    if (
      parent === undefined ||
      !terminalRunStatuses.includes(String(parent.status)) ||
      !timestampBefore(parent.completed_at, now + 1)
    )
      return false;
    const parentValue = readPayload(parent);
    return (
      parentValue.id === parent.run_id &&
      parentValue.threadId === parent.thread_id &&
      parentValue.status === parent.status &&
      parentValue.completedAt === parent.completed_at
    );
  };
}
