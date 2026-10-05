import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replayer, MemoryStorage } from '../src/shared/replayer.js';
import { validateEvents } from '../src/shared/events.js';

const D = (id, channel, seq) => ({ id, type: 'data', channel, seq });
const B = (id, channel, checkpoint, crashStage) =>
  ({ id, type: 'barrier', channel, checkpoint, ...(crashStage ? { crashStage } : {}) });
const F = (id) => ({ id, type: 'fault' });
const R = (id) => ({ id, type: 'reopen' });

async function runRaw(raw) {
  const events = validateEvents(raw);
  const channelCount = new Set(events.filter((e) => e.channel !== null).map((e) => e.channel)).size;
  return new Replayer(channelCount, new MemoryStorage()).run(events);
}

test('整段无故障：两个检查点依次发布，持久化顺序 intent→snapshot→publish', async () => {
  const res = await runRaw([
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1), D('c', 0, 1), B('p1', 1, 1),
    D('d', 0, 2), D('e', 1, 1),
    B('q0', 0, 2), B('q1', 1, 2),
  ]);
  assert.equal(res.error, null);
  assert.deepEqual(res.checkpoints.map((c) => c.cp), [1, 2]);
  const sealStep = res.steps.find((s) => s.kind === 'sealed' && s.checkpoint === 1);
  assert.deepEqual(sealStep.persistence.map((p) => p.stage), ['intent', 'snapshot', 'publish']);
  // cp2 累计：ch0 0+1+2=3, ch1 0+1=1
  assert.deepEqual(res.checkpoints[1].totals, [3, 1]);
});

test('故障后重开：只采用完整发布的最新检查点，从其后重放且不重复', async () => {
  const res = await runRaw([
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1), D('c', 0, 1), B('p1', 1, 1), // cp1 完整发布（含缓存 c）
    D('d', 0, 2),
    F('crash'),
    R('open'),
    // 重放窗口内（inputIndex 5..6）的事件被原序重走
  ]);
  assert.equal(res.error, null);
  const reopen = res.steps.find((s) => s.kind === 'reopen');
  assert.equal(reopen.recovery.restoredCp, 1);
  assert.equal(reopen.recovery.resumeIndex, 4 + 1); // cp1 封存事件 inputIndex=4
  // 重放步：d(inputIndex=5) 重放一次且只计入一次
  const dSteps = res.steps.filter((s) => s.eventId === 'd');
  assert.equal(dSteps.length, 2); // 首次 + 重放
  assert.equal(dSteps[0].replay, false);
  assert.equal(dSteps[1].replay, true);
  const after = dSteps[1].state.channels[0];
  assert.equal(after.total, 0 + 1 + 2); // 快照里 0+1，再 +2 一次，无重复
  assert.equal(after.committedSeq, 2);
  // cp1 的持久化三阶段完整记录在存储日志里
  const cp1Ops = res.storageLog.filter((l) => l.cp === 1).map((l) => l.op);
  assert.deepEqual(cp1Ops, ['intent', 'snapshot', 'publish']);
});

test('intent 阶段后崩溃：半完成检查点不发布，重开后重放重建并只发布一次', async () => {
  const res = await runRaw([
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1), B('p1', 1, 1),   // cp1 在 inputIndex 3 完整发布
    D('c', 0, 1), D('d', 1, 1),
    B('q0', 0, 2),
    B('q1', 1, 2, 'intent'),        // 封存 cp2 时写完 intent 即崩溃
    R('open'),
  ]);
  assert.equal(res.error, null);
  const crash = res.steps.find((s) => s.kind === 'forced-crash');
  assert.ok(crash);
  assert.equal(crash.checkpoint, 2);
  const stages = crash.persistence.map((p) => p.stage);
  assert.deepEqual(stages, ['intent', 'crash']);
  // 崩溃抹除了 cp2 的半完成片段
  assert.ok(crash.persistence.find((p) => p.stage === 'crash').removed.some((r) => r.cp === 2));
  const reopen = res.steps.find((s) => s.kind === 'reopen');
  assert.equal(reopen.recovery.restoredCp, 1);
  assert.equal(reopen.recovery.resumeIndex, 4);
  // 重放窗口 4..7：c、d 直接计入，q0、q1 重新对齐并完整发布 cp2（仅一次）
  const replayKinds = res.steps.filter((s) => s.replay).map((s) => s.kind);
  assert.deepEqual(replayKinds, ['released', 'released', 'barrier', 'sealed']);
  assert.deepEqual(res.checkpoints.map((c) => c.cp), [1, 2]);
  assert.equal(res.checkpoints.filter((c) => c.cp === 2).length, 1);
  assert.deepEqual(res.finalState.channels.map((c) => c.total), [0 + 1, 0 + 1]);
});

test('snapshot 阶段后崩溃：不得显示/采用半完成快照，重开只认 cp1', async () => {
  const res = await runRaw([
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1), B('p1', 1, 1),
    D('c', 0, 1),
    B('q0', 0, 2),
    B('q1', 1, 2, 'snapshot'),      // cp2 snapshot 写完、publish 前崩溃
    R('open'),
  ]);
  assert.equal(res.error, null);
  assert.deepEqual(res.checkpoints.map((c) => c.cp), [1, 2]); // 重放重建后发布
  const crash = res.steps.find((s) => s.kind === 'forced-crash');
  const stages = crash.persistence.map((p) => p.stage);
  assert.deepEqual(stages, ['intent', 'snapshot', 'crash']); // 无 publish
  const removed = crash.persistence.find((p) => p.stage === 'crash').removed;
  assert.ok(removed.some((r) => r.cp === 2 && r.stage === 'snapshot'));
  const reopen = res.steps.find((s) => s.kind === 'reopen');
  assert.equal(reopen.recovery.restoredCp, 1);
  // 半完成 cp2 在重开时不作为恢复点
  assert.ok(!reopen.recovery.ignoredIncomplete.some((x) => x.cp === 2));
});

test('处理期错误定位首个事件：对齐中提前到达更高编号屏障', async () => {
  // 录入静态合法（cp1/2/3 均存在、每通道编号单调），但处理到 ch0 的 cp3 时
  // cp2 尚未在全部通道对齐 -> processing 错误并定位 qbad
  const res = await runRaw([
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1), B('p1', 1, 1), // cp1
    B('q0', 0, 2),                // 开始对齐 cp2，等待 ch1
    B('qbad', 0, 3),              // ch0 提前给 cp3
    B('q1', 1, 2), B('r1', 1, 3),
  ]);
  assert.ok(res.error);
  assert.equal(res.error.kind, 'processing');
  assert.equal(res.error.eventId, 'qbad');
  assert.match(res.error.message, /提前到达/);
  const errStep = res.steps.find((s) => s.kind === 'error');
  assert.equal(errStep.eventId, 'qbad');
  assert.equal(errStep.captureIndex, 5);
  // 错误后不再封存任何检查点
  assert.deepEqual(res.checkpoints.map((c) => c.cp), [1]);
});

test('无已发布检查点时重开从头开始', async () => {
  const res = await runRaw([
    D('a', 0, 0),
    F('crash'),
    R('open'),
    D('b', 1, 0),
    B('p0', 0, 1), B('p1', 1, 1),
  ]);
  assert.equal(res.error, null);
  const reopen = res.steps.find((s) => s.kind === 'reopen');
  assert.equal(reopen.recovery.restoredCp, null);
  assert.equal(reopen.recovery.resumeIndex, 0);
  assert.deepEqual(res.checkpoints.map((c) => c.cp), [1]);
});

test('MemoryStorage 未完整发布不可见', () => {
  const s = new MemoryStorage();
  s.writeIntent(1, 0);
  assert.equal(s.latestPublished(), null);
});
