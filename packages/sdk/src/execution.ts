export type ExecutionState = 'dispatched' | 'accepted' | 'running' | 'waiting_model' | 'waiting_tool' | 'waiting_user' | 'awaiting_review' | 'failed' | 'cancelling' | 'cancelled' | 'unknown' | 'completed';

export interface Execution {
  id: string;
  taskId: string;
  boardId: string;
  workerId: string;
  attempt: number;
  baseCommit: string | null;
  executor: string | null;
  state: ExecutionState;
  waitingFor: string | null;
  phaseSince: number;
  createdAt: number;
  acceptedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
  lastMilestoneAt: number | null;
  lastSequence: number;
}

export interface ExecutionActivity {
  sequence: number;
  kind: 'started' | 'model' | 'tool' | 'user' | 'milestone' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled' | 'gap';
  phase?: 'start' | 'end';
  toolName?: string;
  callId?: string;
  baseCommit?: string | null;
  executor?: string;
}

export interface SessionObservationEvent {
  sequence: number;
  kind: 'session_start' | 'assistant_start' | 'assistant_text' | 'assistant_end' | 'tool_start' | 'tool_end' | 'session_end' | 'redacted' | 'gap';
  messageId?: string;
  contentIndex?: number;
  text?: string;
  callId?: string;
  toolName?: string;
  failed?: boolean;
  /** Server-derived gap before this frame, never trusted from an upload. */
  gapBefore?: boolean;
}
