import {
  isTerminalSession,
  isTerminalTurn,
  RecordNotFoundError,
  terminalSessionFromRequest,
  terminalTurnFromRequest,
} from "@tvic/core";
import type {
  ActiveTurn,
  DurableSessionTransaction,
  EndSessionRequest,
  SessionId,
  TerminalSession,
  Timestamp,
} from "@tvic/core";
import { cancelOpenToolCall, turnEndRequestForSession } from "./runtime-request-helpers.js";
import { durableEvent } from "./runtime-support.js";

export interface PersistedSessionEnd {
  readonly session: TerminalSession;
  readonly shouldEmit: boolean;
}

export async function persistSessionEnd(
  tx: DurableSessionTransaction,
  id: SessionId,
  request: EndSessionRequest,
  now: Timestamp,
  fence: number,
  durationForTurn: (
    sessionId: SessionId,
    turn: ActiveTurn,
    monotonicStartedAtMs: number,
    endedAt: Timestamp,
  ) => number,
): Promise<PersistedSessionEnd> {
  const current = await tx.getSession(id);
  if (!current) throw new RecordNotFoundError(`session:${id}`);
  if (isTerminalSession(current.session)) {
    return { session: current.session, shouldEmit: false };
  }

  const { currentTurnId: _currentTurnId, ...stateWithoutCurrentTurn } = current.session.state;
  const terminalFor = terminalSessionFromRequest(
    {
      id: current.session.id,
      agentId: current.session.agentId,
      channel: current.session.channel,
      ...(current.session.callId ? { callId: current.session.callId } : {}),
      memoryRefs: current.session.memoryRefs,
      ...(current.session.metadata ? { metadata: current.session.metadata } : {}),
      createdAt: current.session.createdAt,
      state: { ...stateWithoutCurrentTurn, pendingToolCallIds: [] },
      startedAt: "startedAt" in current.session ? current.session.startedAt : now,
      endedAt: now,
    },
    request,
  );
  const turnRequest = turnEndRequestForSession(request);
  for (const turnRecord of await tx.listTurns(id)) {
    if (isTerminalTurn(turnRecord.turn)) continue;
    const terminalTurn = terminalTurnFromRequest(
      turnRecord.turn as ActiveTurn,
      turnRequest,
      now,
      durationForTurn(
        id,
        turnRecord.turn as ActiveTurn,
        turnRecord.runtime.monotonicStartedAtMs,
        now,
      ),
    );
    const updatedTurn = await tx.updateTurn(id, turnRecord.turn.id, (record) => ({
      ...record,
      turn: terminalTurn,
    }));
    await tx.appendOutbox(
      durableEvent(
        "turn",
        updatedTurn.turn.id,
        id,
        fence,
        updatedTurn.turn.status,
        updatedTurn.turn,
        updatedTurn.runtime,
        updatedTurn.version,
      ),
    );
  }

  for (const toolRecord of await tx.listToolCalls(id)) {
    if (toolRecord.toolCall.status !== "queued" && toolRecord.toolCall.status !== "running") {
      continue;
    }
    const terminalTool = cancelOpenToolCall(toolRecord.toolCall, now);
    const updatedTool = await tx.updateToolCall(id, toolRecord.toolCall.toolCallId, (record) => ({
      ...record,
      toolCall: terminalTool,
    }));
    await tx.appendOutbox(
      durableEvent(
        "tool_call",
        updatedTool.toolCall.toolCallId,
        id,
        fence,
        updatedTool.toolCall.status,
        updatedTool.toolCall,
        updatedTool.runtime,
        updatedTool.version,
      ),
    );
  }

  const updated = await tx.updateSession(id, (record) => ({
    ...record,
    session: terminalFor,
    runtime: { ...record.runtime, lastActivityWallAtMs: Date.parse(now) },
  }));
  await tx.appendOutbox(
    durableEvent(
      "session",
      id,
      id,
      fence,
      updated.session.status,
      updated.session,
      updated.runtime,
      updated.version,
    ),
  );
  return { session: updated.session as TerminalSession, shouldEmit: true };
}
