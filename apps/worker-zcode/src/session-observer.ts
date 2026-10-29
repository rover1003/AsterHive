import { createHash } from 'node:crypto';
import { redactExecutionText } from './sdk.ts';
import type { SessionObservationEvent } from './sdk.ts';

type VisibleEvent = Omit<SessionObservationEvent, 'sequence'>;
const TOOLS: Record<string, true> = { read: true, write: true, edit: true, bash: true, powershell: true, hive_checkpoint: true };

/** Never forwards raw SDK events, reasoning, tool arguments or results. */
export function createSessionObserver(options: {
  enabled: () => boolean;
  emit: (event: VisibleEvent) => void;
  secrets: string[];
}): (event: Record<string, unknown>) => void {
  let sessionStarted = false;
  let skipped = false;
  let messageId = '';
  let messageNumber = 0;
  let fenced = false;
  let privateKey = false;
  const blocks = new Map<number, { pending: string; overflow: boolean }>();
  const emit = options.emit;
  const redact = (contentIndex?: number) => emit({ kind: 'redacted', messageId: messageId || undefined, contentIndex });
  const line = (text: string, contentIndex: number) => {
    const fenceCount = text.match(/```/g)?.length ?? 0;
    if (fenceCount) {
      if (fenceCount % 2) fenced = !fenced;
      redact(contentIndex);
      return;
    }
    if (/-----BEGIN .*PRIVATE KEY-----/.test(text)) privateKey = true;
    const hidden = fenced || privateKey ||
      /(?:api[_-]?key|password|passwd|secret|token)\s*["']?\s*[:=]/i.test(text) ||
      /https?:\/\/[^\s/@:]+:[^\s@]+@|[?&](?:key|token|secret|password)=/i.test(text);
    if (/-----END .*PRIVATE KEY-----/.test(text)) privateKey = false;
    if (hidden || redactExecutionText(text, options.secrets) !== text) {
      redact(contentIndex);
      return;
    }
    if (text) emit({ kind: 'assistant_text', messageId, contentIndex, text });
  };
  const flush = () => {
    for (const [index, block] of blocks) {
      if (block.overflow) redact(index);
      else if (block.pending) line(block.pending, index);
    }
    blocks.clear();
  };
  const startMessage = () => {
    messageId = `message-${++messageNumber}`;
    fenced = false;
    privateKey = false;
    blocks.clear();
    emit({ kind: 'assistant_start', messageId });
  };
  return (event) => {
    if (!options.enabled()) {
      blocks.clear();
      messageId = '';
      skipped = true;
      return;
    }
    if (!sessionStarted) { emit({ kind: 'session_start' }); sessionStarted = true; }
    if (skipped) { emit({ kind: 'gap' }); skipped = false; }
    const message = event.message as { role?: string } | undefined;
    if (event.type === 'message_start' && message?.role === 'assistant') startMessage();
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent as { type?: string; delta?: string; contentIndex?: number } | undefined;
      if (delta?.type !== 'text_delta' || typeof delta.delta !== 'string') return;
      const index = delta.contentIndex ?? 0;
      if (!Number.isSafeInteger(index) || index < 0 || index >= 8) { redact(); return; }
      if (!messageId) startMessage();
      let block = blocks.get(index);
      if (!block) { block = { pending: '', overflow: false }; blocks.set(index, block); }
      // Hold complete lines, not prefixes: a credential split across chunks is inspected as one unit.
      for (const part of delta.delta.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (!block.overflow) {
          block.pending += part;
          if (block.pending.length > 2048) { block.pending = ''; block.overflow = true; }
        }
        if (part.endsWith('\n')) {
          if (block.overflow) redact(index); else line(block.pending, index);
          block.pending = '';
          block.overflow = false;
        }
      }
    }
    if (event.type === 'message_end' && message?.role === 'assistant') {
      flush();
      if (messageId) emit({ kind: 'assistant_end', messageId });
      messageId = '';
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const toolName = typeof event.toolName === 'string' && Object.hasOwn(TOOLS, event.toolName) ? event.toolName : 'unknown';
      const callId = createHash('sha256').update(String(event.toolCallId ?? '')).digest('hex').slice(0, 24);
      emit({ kind: event.type === 'tool_execution_start' ? 'tool_start' : 'tool_end', toolName, callId, failed: event.isError === true });
    }
    if (event.type === 'observation_session_end') {
      flush();
      emit({ kind: 'session_end', failed: event.failed === true });
    }
  };
}
