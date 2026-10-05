// 共享事件模型与校验工具。
// 事件在录入区按“捕获顺序”排列（跨通道统一时间线）。
// 类型：data | barrier | fault | reopen
export const EVENT_TYPES = ['data', 'barrier', 'fault', 'reopen'];

export class AlignerError extends Error {
  // kind 用于页面区分：validation = 录入不合法；processing = 回放处理期失配
  constructor(message, eventId, kind = 'validation') {
    super(message);
    this.name = 'AlignerError';
    this.eventId = eventId ?? null;
    this.kind = kind;
  }
}

/**
 * 校验录入事件。
 * constraints: { minChannels, maxChannels, maxEvents, supportedCheckpoints }
 * 返回标准化后的事件数组（字段齐全、通道转数字、seq 转数字）。
 */
export function validateEvents(events, constraints = {}) {
  const {
    minChannels = 2,
    maxChannels = 4,
    maxEvents = 48,
  } = constraints;

  if (!Array.isArray(events)) {
    throw new AlignerError('事件列表必须是数组', null);
  }
  if (events.length === 0) {
    throw new AlignerError('至少需要一条事件', null);
  }
  if (events.length > maxEvents) {
    throw new AlignerError(`事件总数不得超过 ${maxEvents} 项（当前 ${events.length} 项）`, null);
  }

  const channels = new Set();
  let hasData = false;
  const seenBarriers = new Set();

  const norm = events.map((raw, index) => {
    const id = raw.id ?? `e${index + 1}`;
    const fail = (msg, kind = 'validation') => new AlignerError(msg, id, kind);

    if (!raw || typeof raw !== 'object') throw fail('事件必须是对象');
    const type = String(raw.type || '').toLowerCase();
    if (!EVENT_TYPES.includes(type)) throw fail(`不支持的事件类型：${raw.type}`);

    let ch = null;
    if (type === 'data' || type === 'barrier') {
      ch = Number(raw.channel);
      if (!Number.isInteger(ch) || ch < 0) {
        throw fail(`通道编号必须是非负整数（实际 ${raw.channel}）`);
      }
      channels.add(ch);
    }

    let seq = null;
    if (type === 'data') {
      hasData = true;
      seq = Number(raw.seq);
      if (!Number.isInteger(seq) || seq < 0) {
        throw fail(`数据序号必须是非负整数（实际 ${raw.seq}）`);
      }
    }

    let cp = null;
    if (type === 'barrier') {
      cp = Number(raw.checkpoint);
      if (!Number.isInteger(cp) || cp < 1) {
        throw fail(`检查点编号必须是正整数（实际 ${raw.checkpoint}）`);
      }
    }

    let value = null;
    if (type === 'data') {
      // value 可选，缺省按 seq 参与运算，保证演示确定性
      if (raw.value !== undefined && raw.value !== null && raw.value !== '') {
        const v = Number(raw.value);
        if (!Number.isFinite(v)) throw fail(`数据值必须是数值（实际 ${raw.value}）`);
        value = v;
      }
    }

    // 仅在 barrier 事件上有意义：在持久化 intent 或 snapshot 阶段后强制崩溃
    let crashStage = null;
    if (type === 'barrier' && raw.crashStage) {
      const s = String(raw.crashStage).toLowerCase();
      if (s !== 'intent' && s !== 'snapshot') {
        throw fail(`crashStage 只允许 intent 或 snapshot（实际 ${raw.crashStage}）`);
      }
      crashStage = s;
    }

    return {
      id,
      type,
      channel: ch,
      seq,
      checkpoint: cp,
      value: value === null ? seq : value,
      crashStage,
      _index: index,
    };
  });

  if (channels.size < minChannels) {
    throw new AlignerError(`至少需要 ${minChannels} 条输入通道（当前 ${channels.size} 条）`);
  }
  if (channels.size > maxChannels) {
    throw new AlignerError(`最多允许 ${maxChannels} 条输入通道（当前 ${channels.size} 条）`);
  }
  // 通道编号规整为 0..n-1，避免 UI 空洞（逻辑本身支持任意编号）
  const sorted = [...channels].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i) {
      // 重新编号为 0..n-1，避免 UI 空洞
      const remap = new Map(sorted.map((c, k) => [c, k]));
      for (const e of norm) {
        if (e.channel !== null) e.channel = remap.get(e.channel);
      }
      break;
    }
  }

  if (!hasData) throw new AlignerError('至少需要一条 data 事件');

  // 每通道数据序号严格递增；检查点屏障在同一通道不可重复
  const lastSeq = new Map();
  const barrierSeen = new Map(); // channel -> Set(cp)
  for (const e of norm) {
    if (e.type === 'data') {
      const prev = lastSeq.get(e.channel);
      if (prev !== undefined && e.seq <= prev) {
        throw new AlignerError(
          `通道 ${e.channel} 数据序号必须严格递增（出现 ${prev} 之后的 ${e.seq}）`,
          e.id
        );
      }
      lastSeq.set(e.channel, e.seq);
    }
    if (e.type === 'barrier') {
      if (!barrierSeen.has(e.channel)) barrierSeen.set(e.channel, new Set());
      const set = barrierSeen.get(e.channel);
      if (set.has(e.checkpoint)) {
        throw new AlignerError(
          `通道 ${e.channel} 上检查点 ${e.checkpoint} 的屏障重复`,
          e.id
        );
      }
      set.add(e.checkpoint);
    }
  }

  // 全局：同一 cp 的屏障一旦出现，不允许在其后再出现上一检查点编号的屏障（乱序 cp）
  // 逐通道判定，首个违例事件即定位点。
  const maxCpPerChannel = new Map();
  for (const e of norm) {
    if (e.type === 'barrier') {
      const prevMax = maxCpPerChannel.get(e.channel) ?? 0;
      if (e.checkpoint < prevMax) {
        throw new AlignerError(
          `通道 ${e.channel} 屏障编号回退（已见 ${prevMax}，又出现 ${e.checkpoint}）`,
          e.id
        );
      }
      maxCpPerChannel.set(e.channel, Math.max(prevMax, e.checkpoint));
    }
  }

  // 检查点编号需在所有出现通道上一致推进：更严格地，屏障集合按通道只能是同一组 cp。
  // 收集每个 cp 出现在哪些通道；若某 cp 仅部分通道出现，校验阶段放行（可能永远对齐不了，
  // 由处理阶段按“未完成检查点”呈现，不算非法），但编号必须从 1 起且整体不跳号地覆盖到最大值。
  for (const e of norm) {
    if (e.type === 'barrier') seenBarriers.add(e.checkpoint);
  }
  if (seenBarriers.size > 0) {
    const cps = [...seenBarriers].sort((a, b) => a - b);
    for (let i = 0; i < cps.length; i++) {
      if (cps[i] !== i + 1) {
        const first = norm.find((x) => x.type === 'barrier' && x.checkpoint === cps[i]);
        throw new AlignerError(
          `检查点编号必须从 1 起连续，不得跳号（缺少 ${i + 1}，却出现 ${cps[i]}）`,
          first ? first.id : null
        );
      }
    }
  }

  return norm.map(({ _index, ...rest }) => ({ ...rest }));
}

/** 默认示例：两通道、两个检查点、一次故障重开。 */
export const SAMPLE_EVENTS = [
  { id: 'e1', type: 'data', channel: 0, seq: 0 },
  { id: 'e2', type: 'data', channel: 1, seq: 0 },
  { id: 'e3', type: 'barrier', channel: 0, checkpoint: 1 },
  { id: 'e4', type: 'data', channel: 0, seq: 1 },   // 屏障先到 ch0：缓存
  { id: 'e5', type: 'data', channel: 1, seq: 1 },
  { id: 'e6', type: 'barrier', channel: 1, checkpoint: 1 }, // 对齐：封存 cp1
  { id: 'e7', type: 'data', channel: 0, seq: 2 },
  { id: 'e8', type: 'data', channel: 1, seq: 2 },
  { id: 'e9', type: 'barrier', channel: 0, checkpoint: 2 },
  { id: 'e10', type: 'fault' },
  { id: 'e11', type: 'reopen' },
  { id: 'e12', type: 'barrier', channel: 1, checkpoint: 2 },
  { id: 'e13', type: 'data', channel: 0, seq: 3 },
  { id: 'e14', type: 'data', channel: 1, seq: 3 },
];
