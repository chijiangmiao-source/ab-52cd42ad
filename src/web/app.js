import { SAMPLE_EVENTS } from '../shared/events.js';

const MAX_EVENTS = 48;
const $ = (sel) => document.querySelector(sel);

const tbody = $('#event-table tbody');
const runStatus = $('#run-status');
const validationError = $('#validation-error');
const results = $('#results');
const cpList = $('#checkpoint-list');
const timelineEl = $('#timeline');
const stepView = $('#step-view');
const slider = $('#step-slider');
const stepLabel = $('#step-label');

let rows = [];
let lastResult = null;

function uid() {
  return 'e' + Math.random().toString(36).slice(2, 7);
}

function addRow(partial = {}) {
  if (rows.length >= MAX_EVENTS) {
    alert(`最多 ${MAX_EVENTS} 项事件`);
    return;
  }
  rows.push({
    id: uid(),
    type: 'data',
    channel: '0',
    seq: '0',
    checkpoint: '1',
    value: '',
    crashStage: '',
    ...partial,
  });
  renderRows();
}

function renderRows() {
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const cell = (html) => { const td = document.createElement('td'); td.innerHTML = html; return td; };

    tr.appendChild(cell(`<span class="rowidx">${i}</span>`));
    tr.appendChild(cell(`<input class="wide" data-k="id" value="${r.id}"/>`));

    const typeTd = document.createElement('td');
    typeTd.innerHTML = `
      <select data-k="type">
        <option value="data"${r.type === 'data' ? ' selected' : ''}>data 数据</option>
        <option value="barrier"${r.type === 'barrier' ? ' selected' : ''}>barrier 屏障</option>
        <option value="fault"${r.type === 'fault' ? ' selected' : ''}>fault 故障</option>
        <option value="reopen"${r.type === 'reopen' ? ' selected' : ''}>reopen 重开</option>
      </select>`;
    tr.appendChild(typeTd);

    const chReadonly = r.type === 'fault' || r.type === 'reopen';
    tr.appendChild(cell(`<input data-k="channel" value="${r.channel}"${chReadonly ? ' disabled' : ''}/>`));
    tr.appendChild(cell(`<input data-k="seq" value="${r.seq}"${r.type !== 'data' ? ' disabled' : ''}/>`));
    tr.appendChild(cell(`<input data-k="checkpoint" value="${r.checkpoint}"${r.type !== 'barrier' ? ' disabled' : ''}/>`));
    tr.appendChild(cell(`<input data-k="value" value="${r.value}"${r.type !== 'data' ? ' disabled' : ''}/>`));
    tr.appendChild(cell(`
      <select data-k="crashStage" style="width:110px"${r.type !== 'barrier' ? ' disabled' : ''}>
        <option value=""${!r.crashStage ? ' selected' : ''}>—</option>
        <option value="intent"${r.crashStage === 'intent' ? ' selected' : ''}>intent 后崩</option>
        <option value="snapshot"${r.crashStage === 'snapshot' ? ' selected' : ''}>snapshot 后崩</option>
      </select>`));

    const delTd = document.createElement('td');
    delTd.innerHTML = '<button type="button" class="del">删</button>';
    delTd.querySelector('button').onclick = () => { rows.splice(i, 1); renderRows(); };
    tr.appendChild(delTd);

    tr.querySelectorAll('[data-k]').forEach((el) => {
      el.addEventListener('input', () => {
        const k = el.dataset.k;
        rows[i][k] = el.value;
        if (k === 'type') renderRows();
      });
    });
    tbody.appendChild(tr);
  });
}

function collectEvents() {
  return rows.map((r) => {
    const e = { id: r.id, type: r.type };
    if (r.type === 'data' || r.type === 'barrier') e.channel = Number(r.channel);
    if (r.type === 'data') {
      e.seq = Number(r.seq);
      if (r.value !== '') e.value = Number(r.value);
    }
    if (r.type === 'barrier') {
      e.checkpoint = Number(r.checkpoint);
      if (r.crashStage) e.crashStage = r.crashStage;
    }
    return e;
  });
}

// ---------- Worker 通信 ----------
let worker = null;
let nextMsgId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/assets/worker.js');
  worker.onmessage = (m) => {
    const { id, ok, payload, error } = m.data;
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    ok ? p.resolve(payload) : p.reject(error);
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject({ message: 'Worker 错误：' + e.message });
    pending.clear();
  };
  return worker;
}

function callWorker(payload) {
  const w = ensureWorker();
  const id = nextMsgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, payload });
  });
}

// ---------- 渲染 ----------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderCheckpoints(events, result) {
  cpList.innerHTML = '';
  if (result.checkpoints.length === 0) {
    cpList.innerHTML = '<p class="hint">没有完整发布的检查点。</p>';
    return;
  }
  for (const cp of result.checkpoints) {
    const card = document.createElement('div');
    card.className = 'cp-card';
    const rangeHtml = cp.ranges.map((r) => {
      const items = r.items.length ? r.items.join(', ') : '∅';
      return `<div class="range-line">通道 <b>${r.channel}</b> 纳入序号：` +
        `${r.fromSeq === null ? '∅' : r.fromSeq} → ${r.toSeq === null ? '∅' : r.toSeq} ` +
        `<span class="meta">[${items}]</span></div>`;
    }).join('');
    const totalHtml = cp.totals.map((t, c) => `ch${c}=${t}`).join('  ');
    const bufHtml = cp.bufferedCount === 0
      ? '<div class="buf-note">无缓存（所有通道屏障前数据均已直接计入）</div>'
      : `<div class="buf-note">缓存 ${cp.bufferedCount} 项，封存后按原序释放：` +
        cp.releasedBuffer.map((b) => `${b.eventId}(ch${b.channel}#${b.seq})`).join(' → ') +
        `</div>` +
        cp.releasedBuffer.map((b) => `<div class="buf-note">　└ ${esc(b.eventId)} 缓存原因：${esc(b.reason)}</div>`).join('');
    card.innerHTML = `
      <h4>检查点 CP${cp.cp} <span class="meta">（事件 ${esc(cp.viaEventId)} 触发封存，输入序号 ${cp.inputIndex}）</span></h4>
      ${rangeHtml}
      ${bufHtml}
      <div class="totals">封存累计值：${totalHtml}</div>
      <div class="meta">恢复起点：从输入序号 ${cp.inputIndex + 1} 继续，缓存已并入快照，不重放不重复</div>`;
    cpList.appendChild(card);
  }
}

function describeStep(step) {
  switch (step.kind) {
    case 'released':
      return `数据 ${step.eventId}（ch${step.outcome.channel}#${step.outcome.seq}）直接计入，值 +${step.outcome.value}`;
    case 'buffered':
      return `数据 ${step.eventId}（ch${step.outcome.channel}#${step.outcome.seq}）缓存：${esc(step.outcome.reason)}`;
    case 'barrier':
      return `屏障 ${step.eventId}：CP${step.outcome.checkpoint} 到达 ch${step.outcome.channel}，等待通道 [${step.outcome.waitingChannels.join(', ')}]`;
    case 'sealed':
      return `CP${step.checkpoint} 在 ${step.eventId} 封存，持久化顺序：` +
        step.persistence.map((p) => p.stage).join(' → ');
    case 'fault':
      return `故障 ${step.eventId}：进程中断` +
        (step.removedArtifacts.length
          ? `，丢弃未完成片段：${step.removedArtifacts.map((a) => `CP${a.cp}@${a.stage}`).join(', ')}`
          : '（无未完成片段）');
    case 'forced-crash':
      return `崩溃注入 ${step.eventId}：CP${step.checkpoint} 持久化在 ${step.persistence[step.persistence.length - 1].stage} 阶段后中断，半完成快照不发布`;
    case 'reopen':
      return `重开 ${step.eventId}：采用最新完整发布检查点 ` +
        (step.recovery.restoredCp === null ? '无（从头开始）' : `CP${step.recovery.restoredCp}`) +
        `，从输入序号 ${step.recovery.resumeIndex} 重放` +
        (step.recovery.ignoredIncomplete.length
          ? `；忽略半完成片段：${step.recovery.ignoredIncomplete.map((a) => `CP${a.cp}@${a.stage}`).join(', ')}`
          : '');
    case 'dropped-outage':
      return `中断窗口事件 ${step.eventId} 未处理，等待重开后重放`;
    case 'error':
      return `错误定位在 ${step.eventId}（捕获序号 ${step.captureIndex}）：${esc(step.error.message)}`;
    default:
      return `${step.kind} ${step.eventId ?? ''}`;
  }
}

function renderTimeline(events, result) {
  timelineEl.innerHTML = '';
  result.steps.forEach((step) => {
    const li = document.createElement('li');
    li.className = [step.kind, step.replay ? 'replay' : ''].filter(Boolean).join(' ');
    const tag = step.replay ? `${step.kind}·重放` : step.kind;
    const replayMark = step.replay ? '<span class="detail">（从检查点后原序重放）</span>' : '';
    li.innerHTML = `<span class="evid">#${step.captureIndex ?? '?'}</span>` +
      `<span class="tag ${step.kind}">${esc(tag)}</span> ` +
      `${esc(describeStep(step))} ${replayMark}`;
    timelineEl.appendChild(li);
  });
}

function renderState(step, events) {
  if (!step || !step.state) {
    stepView.innerHTML = '<p class="hint">该步进程不在线（故障/崩溃中），无通道状态。</p>';
    return;
  }
  const s = step.state;
  const pending = s.pendingCp === null
    ? '无'
    : `CP${s.pendingCp}（已到通道 [${s.arrivedChannels.join(', ')}]，等待 [${s.waitingChannels.join(', ')}]）`;
  const rowsHtml = s.channels.map((c) => `
    <tr>
      <td>通道 ${c.channel}</td>
      <td>${c.total}</td>
      <td>${c.lastSeq === null ? '∅' : c.lastSeq}</td>
      <td>${c.committedSeq === null ? '∅' : c.committedSeq}</td>
      <td>${c.barrierCp === null ? '—' : 'CP' + c.barrierCp}</td>
      <td>${c.buffered.length ? c.buffered.map((b) => `#${b.seq}`).join(', ') : '—'}</td>
    </tr>`).join('');
  const bufOrder = s.bufferOrder.length
    ? s.bufferOrder.map((b) => `${b.eventId}(ch${b.channel}#${b.seq})`).join(' → ')
    : '空';
  stepView.innerHTML = `
    <p class="meta">正在对齐：${pending}　|　下一输入序号：${s.nextInputIndex}　|　已封存：CP${s.everSealed}</p>
    <table class="state">
      <thead><tr><th>通道</th><th>当前累计值</th><th>已观测末序号</th><th>已计入末序号</th><th>屏障位置</th><th>缓存中序号</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p class="meta">缓存队列（捕获原序）：${esc(bufOrder)}</p>`;
}

function bindSlider() {
  const steps = lastResult.result.steps;
  slider.max = String(steps.length - 1);
  slider.value = String(steps.length - 1);
  const update = () => {
    const i = Number(slider.value);
    const step = steps[i];
    stepLabel.textContent = `步 ${i + 1} / ${steps.length} — ${step.kind}${step.replay ? '（重放）' : ''}`;
    renderState(step);
  };
  slider.oninput = update;
  update();
}

async function run() {
  validationError.classList.add('hidden');
  results.classList.add('hidden');
  runStatus.textContent = 'Worker 回放中…';
  const events = collectEvents();
  try {
    const payload = await callWorker({ events, constraints: { minChannels: 2, maxChannels: 4, maxEvents: MAX_EVENTS } });
    lastResult = payload;
    runStatus.textContent = payload.result.error
      ? `回放中止：已定位首个错误事件 ${payload.result.error.eventId}`
      : '回放完成';
    runStatus.style.color = payload.result.error ? 'var(--err)' : 'var(--accent-2)';
    renderCheckpoints(payload.events, payload.result);
    renderTimeline(payload.events, payload.result);
    if (payload.result.error) {
      validationError.textContent =
        `首个错误事件：${payload.result.error.eventId ?? '(输入序号层面)'} — ${payload.result.error.message}`;
      validationError.classList.remove('hidden');
    }
    results.classList.remove('hidden');
    bindSlider();
  } catch (e) {
    runStatus.textContent = '校验失败';
    runStatus.style.color = 'var(--err)';
    validationError.textContent =
      `录入校验未通过（首个事件：${e.eventId ?? '—'}）：${e.message}`;
    validationError.classList.remove('hidden');
  }
}

// ---------- 按钮 ----------
$('#btn-add-data').onclick = () => addRow({ type: 'data' });
$('#btn-add-barrier').onclick = () => addRow({ type: 'barrier' });
$('#btn-add-fault').onclick = () => addRow({ type: 'fault' });
$('#btn-add-reopen').onclick = () => addRow({ type: 'reopen' });
$('#btn-clear').onclick = () => { rows = []; renderRows(); };
$('#btn-sample').onclick = () => { rows = SAMPLE_EVENTS.map((e) => ({
  id: e.id, type: e.type,
  channel: e.channel ?? '', seq: e.seq ?? '', checkpoint: e.checkpoint ?? '1',
  value: e.value !== undefined ? String(e.value) : '', crashStage: e.crashStage ?? '',
})); renderRows(); };
$('#btn-run').onclick = run;

// 初始：载入示例
rows = SAMPLE_EVENTS.map((e) => ({
  id: e.id, type: e.type,
  channel: e.channel ?? '', seq: e.seq ?? '', checkpoint: e.checkpoint ?? '1',
  value: e.value !== undefined ? String(e.value) : '', crashStage: e.crashStage ?? '',
}));
renderRows();
