import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const mode = process.env.FAKE_RPC_MODE ?? 'success';
const state = { sessionId: 'fake-session', sessionFile: 'fake-session.jsonl', contextUsage: { percent: 12 }, isSettled: true };
process.stdout.write(`${JSON.stringify({ type: 'ready', protocolVersion: 1 })}\n`);

rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const id = req.id;
  const respond = (command, data = {}, success = true) =>
    process.stdout.write(`${JSON.stringify({ type: 'response', id, command, success, data })}\n`);
  switch (req.type) {
    case 'get_state': respond('get_state', state); break;
    case 'prompt':
      respond('prompt', { agentInvoked: true });
      setTimeout(() => {
        if (mode === 'prompt-error') {
          process.stdout.write(`${JSON.stringify({ type: 'prompt_result', id, status: 'error', error: 'fake-error' })}\n`);
          return;
        }
        process.stdout.write(`${JSON.stringify({ type: 'prompt_result', id, status: 'completed' })}\n`);
      }, 10);
      break;
    case 'get_last_assistant_text':
      respond('get_last_assistant_text', mode === 'no-last-text' ? {} : { text: 'fake completed result' });
      break;
    case 'compact': respond('compact', { compacted: true }); break;
    case 'abort': respond('abort', { aborted: true }); break;
    default: respond(req.type, {}, false);
  }
});

process.on('SIGTERM', () => { rl.close(); process.exit(0); });
