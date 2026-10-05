// 回放 Worker：所有屏障对齐与持久化回放都在 Worker 内完成，
// 浏览器中断（fault）通过存储三阶段写入显式建模。
import { validateEvents, AlignerError } from '../shared/events.js';
import { Replayer, MemoryStorage } from '../shared/replayer.js';

async function simulate(events, constraints) {
  const normalized = validateEvents(events, constraints);
  const channelCount = new Set(
    normalized.filter((e) => e.channel !== null).map((e) => e.channel)
  ).size;
  const storage = new MemoryStorage();
  const replayer = new Replayer(channelCount, storage);
  const result = await replayer.run(normalized);
  return {
    ok: true,
    channelCount,
    events: normalized.map(({ _index, ...rest }) => rest),
    result,
  };
}

self.onmessage = async (msg) => {
  const { id, payload } = msg.data || {};
  try {
    const out = await simulate(payload.events, payload.constraints);
    self.postMessage({ id, ok: true, payload: out });
  } catch (e) {
    if (e instanceof AlignerError) {
      self.postMessage({
        id, ok: false,
        error: { message: e.message, eventId: e.eventId, kind: e.kind },
      });
    } else {
      self.postMessage({ id, ok: false, error: { message: String(e && e.message || e) } });
    }
  }
};
