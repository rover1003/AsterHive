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
  let fence: { marker: string; length: number } | null = null;
  let suppressRemainder = false;
  let privateKey = false;
  const blocks = new Map<number, { pending: string; overflow: boolean }>();
  const emit = options.emit;
  const redact = (contentIndex?: number) => emit({ kind: 'redacted', messageId: messageId || undefined, contentIndex });
  const line = (text: string, contentIndex: number) => {
    if (suppressRemainder) { redact(contentIndex); return; }
    const delimiter = /`{3,}|~{3,}/.exec(text);
    if (fence) {
      if (delimiter && delimiter[0][0] === fence.marker && delimiter[0].length >= fence.length &&
          /^[ \t>]*$/.test(text.slice(0, delimiter.index)) &&
          text.slice(delimiter.index + delimiter[0].length).trim() === '') fence = null;
      redact(contentIndex);
      return;
    }
    if (delimiter) {
      fence = { marker: delimiter[0][0], length: delimiter[0].length };
      redact(contentIndex);
      return;
    }
    if (/-----BEGIN .*PRIVATE KEY-----/.test(text)) privateKey = true;
    const label = /(?:api[_-]?key|password|passwd|secret|token|authorization)\s*["']?\s*[:=]\s*/i.exec(text);
    const value = label ? text.slice(label.index + label[0].length).trim() : '';
    const incompleteValue = label !== null && (!value || /^[|>]/.test(value) ||
      ((value.startsWith('"') || value.startsWith("'")) && !value.endsWith(value[0])));
    if (incompleteValue || /\bBearer\s*$/i.test(text)) suppressRemainder = true;
    const hidden = privateKey || suppressRemainder || label !== null ||
      /^(?: {0,3}> ?)*(?: {4}|\t)/.test(text) ||
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
      if (block.overflow) { suppressRemainder = true; redact(index); }
      else if (block.pending) line(block.pending, index);
    }
    blocks.clear();
  };
  const startMessage = () => {
    messageId = `message-${++messageNumber}`;
    fence = null;
    suppressRemainder = false;
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
    const message = event.message;
    const role = message !== null && typeof message === 'object' && 'role' in message ? message.role : undefined;
    if (event.type === 'message_start' && role === 'assistant') startMessage();
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (delta === null || typeof delta !== 'object' || !('type' in delta) ||
          (delta.type !== 'text_delta' && delta.type !== 'text_end')) return;
      const index = 'contentIndex' in delta ? delta.contentIndex : 0;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= 8) { redact(); return; }
      if (delta.type === 'text_end') {
        const completed = blocks.get(index);
        if (completed?.overflow) { suppressRemainder = true; redact(index); }
        else if (completed?.pending) line(completed.pending, index);
        blocks.delete(index);
        return;
      }
      if (!('delta' in delta) || typeof delta.delta !== 'string') return;
      for (const [other, pending] of blocks) {
        if (other !== index && (pending.pending.length > 0 || pending.overflow)) {
          suppressRemainder = true;
          break;
        }
      }
      if (!messageId) {
        messageId = `fragment-${++messageNumber}`;
        suppressRemainder = true;
      }
      let block = blocks.get(index);
      if (!block) { block = { pending: '', overflow: false }; blocks.set(index, block); }
      // Hold complete lines, not prefixes: a credential split across chunks is inspected as one unit.
      for (const part of delta.delta.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (!block.overflow) {
          block.pending += part;
          if (block.pending.length > 2048) { block.pending = ''; block.overflow = true; }
        }
        if (part.endsWith('\n')) {
          if (block.overflow) { suppressRemainder = true; redact(index); } else line(block.pending, index);
          block.pending = '';
          block.overflow = false;
        }
      }
    }
    if (event.type === 'message_end' && role === 'assistant') {
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
