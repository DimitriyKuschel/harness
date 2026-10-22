// Manual end-to-end check against the real CLIs (spends a little quota):
//   node dist-test/smoke.js <claude|codex|gemini> "<prompt>" [model] [sessionId]
import { ClaudeAdapter } from '../core/agents/claude';
import { CodexAdapter } from '../core/agents/codex';
import { GeminiAdapter } from '../core/agents/gemini';

const [which = 'claude', prompt = 'Reply with: pong', model, sessionId] = process.argv.slice(2);
const log = { info: (m: string) => console.error('[log]', m), error: (m: string) => console.error('[err]', m) };
const adapter =
  which === 'codex' ? new CodexAdapter(() => 'codex', log) : which === 'gemini' ? new GeminiAdapter(() => 'agy', log) : new ClaudeAdapter(() => 'claude', log);

void (async () => {
  console.log('DETECT', JSON.stringify(await adapter.detect()));
  const out = await adapter.run(
    { prompt, cwd: process.cwd(), model, effort: 'low', autonomy: 'readonly', sessionId, systemPrompt: 'Отвечай по-русски.' },
    (e) => console.log('EVENT', JSON.stringify(e)),
    new AbortController().signal,
  );
  console.log('OUTCOME', JSON.stringify(out));
})();
