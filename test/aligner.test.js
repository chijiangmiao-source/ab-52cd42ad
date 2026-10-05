import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aligner } from '../src/shared/aligner.js';
import { validateEvents, AlignerError } from '../src/shared/events.js';

const D = (id, channel, seq, value) => ({ id, type: 'data', channel, seq, value: value ?? seq });
const B = (id, channel, checkpoint) => ({ id, type: 'barrier', channel, checkpoint });

function feed(aligner, events) {
  const outcomes = [];
  events.forEach((e, i) => outcomes.push(aligner.handle(e, i)));
  return outcomes;
}

test('屏障先到通道后数据缓存，全部屏障到齐才封存并按原序释放', () => {
  const events = [
    D('a', 0, 0), D('b', 1, 0),
    B('b0', 0, 1),
    D('c', 0, 1),          // ch0 屏障已过：缓存
    D('d', 0, 2),          // 继续缓存
    D('e', 1, 1),
    B('b1', 1, 1),         // 对齐：封存
  ];
  const a = new Aligner(2);
  const out = feed(a, events);

  assert.equal(out[3].kind, 'buffered');
  assert.equal(out[4].kind, 'buffered');
  assert.match(out[3].reason, /等待通道 \[1\]/);

  const seal = out[6];
  assert.equal(seal.kind, 'sealed');
  // 缓存按捕获原序释放
  assert.deepEqual(seal.snapshot.releasedBuffer.map((x) => x.eventId), ['c', 'd']);
  // 封存后累计值 = 直接计入 {0,1} + 缓存 {1,2} on ch0；ch1 {0,1}
  assert.deepEqual(seal.snapshot.totals, [0 + 1 + 2, 0 + 1]);
  // 纳入范围只含屏障前直接计入的数据（0..0），缓存单列
  assert.deepEqual(seal.snapshot.ranges.map((r) => [r.fromSeq, r.toSeq]), [[0, 0], [0, 1]]);
});

test('已越过屏障的数据不会混入封存前状态：sealedTotals 不含缓存', () => {
  const events = [
    D('a', 0, 0), B('b0', 0, 1),
    D('c', 0, 1), // 缓存
    D('d', 1, 0), B('b1', 1, 1),
  ];
  const a = new Aligner(2);
  const out = feed(a, events);
  const seal = out[4];
  assert.deepEqual(seal.snapshot.sealedTotals, [0, 0]); // ch0 的 #1 在缓存，未封存进去
  assert.deepEqual(seal.snapshot.totals, [0 + 1, 0]);   // 发布快照含释放后累计
});

test('三通道：仅两个通道屏障到时，两通道数据都缓存，第三个继续计入', () => {
  const events = [
    D('a', 0, 0), D('b', 1, 0), D('c', 2, 0),
    B('x0', 0, 1), B('x1', 1, 1),
    D('d', 0, 1), // 缓存
    D('e', 1, 1), // 缓存
    D('f', 2, 1), // ch2 屏障未到：直接计入
    B('x2', 2, 1),
  ];
  const a = new Aligner(3);
  const out = feed(a, events);
  assert.equal(out[5].kind, 'buffered'); // d
  assert.equal(out[6].kind, 'buffered'); // e
  assert.equal(out[7].kind, 'released'); // f：ch2 屏障未到，直接计入
  const seal = out[8];
  assert.deepEqual(seal.snapshot.releasedBuffer.map((x) => x.eventId), ['d', 'e']);
  assert.deepEqual(seal.snapshot.totals, [0 + 1, 0 + 1, 0 + 1]);
});

test('重复屏障在处理期定位首个事件', () => {
  const events = [
    D('a', 0, 0), D('b', 1, 0),
    B('p', 0, 1), B('q', 1, 1),
    B('dup', 0, 1), // cp1 已在 ch0 接收
  ];
  const a = new Aligner(2);
  feed(a, events.slice(0, 4));
  assert.throws(() => a.handle(events[4], 4), (e) => {
    return e instanceof AlignerError && e.eventId === 'dup' && /重复屏障/.test(e.message);
  });
});

test('屏障跳号（缺 cp1 直接 cp2）定位首个事件', () => {
  const a = new Aligner(2);
  a.handle(D('a', 0, 0), 0);
  a.handle(D('b', 1, 0), 1);
  assert.throws(() => a.handle(B('jump', 0, 2), 2), (e) =>
    e instanceof AlignerError && e.eventId === 'jump' && /跳号/.test(e.message));
});

test('对齐中途提前到达下一编号屏障', () => {
  const a = new Aligner(2);
  const events = [
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1),
    B('p1bad', 0, 2), // cp1 尚未对齐，ch0 提前给 cp2
  ];
  assert.throws(() => feed(a, events), (e) => e.eventId === 'p1bad' && /提前到达/.test(e.message));

  const a2 = new Aligner(2);
  const ev2 = [
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1),
    B('p2', 1, 2), // cp1 未齐，ch1 提前给 cp2
  ];
  assert.throws(() => feed(a2, ev2), (e) => e.eventId === 'p2' && /提前到达/.test(e.message));
});

test('数据序号跳号与重复计入检测', () => {
  const a = new Aligner(2);
  a.handle(D('a', 0, 0), 0);
  a.handle(D('b', 1, 0), 1);
  assert.throws(() => a.handle(D('gap', 0, 5), 2), (e) =>
    e.eventId === 'gap' && /跳号/.test(e.message));

  const a2 = new Aligner(2);
  a2.handle(D('a', 0, 0), 0);
  assert.throws(() => a2.handle(D('dup', 0, 0), 1), (e) =>
    e.eventId === 'dup' && /重复计入|重复/.test(e.message));
});

test('输入序号断层', () => {
  const a = new Aligner(2);
  a.handle(D('a', 0, 0), 0);
  assert.throws(() => a.handle(D('b', 1, 0), 2), /输入序号断层/);
});

test('校验阶段：通道数、事件数、录入重复屏障、屏障编号回退', () => {
  assert.throws(() => validateEvents([D('a', 0, 0)], { minChannels: 2 }), /至少需要 2 条/);

  const many = [];
  for (let i = 0; i < 49; i++) many.push(D(`e${i}`, i % 2, Math.floor(i / 2)));
  assert.throws(() => validateEvents(many), /48/);

  assert.throws(() => validateEvents([
    D('a', 0, 0), D('b', 1, 0),
    B('p', 0, 1), B('q', 1, 1),
    B('dup', 0, 1),
  ]), (e) => e.eventId === 'dup');

  assert.throws(() => validateEvents([
    D('a', 0, 0), D('b', 1, 0),
    B('p', 0, 2),
  ]), /不得跳号/);

  assert.throws(() => validateEvents([
    D('a', 0, 0), D('b', 1, 0),
    B('p', 0, 1), B('q', 1, 1),
    B('r', 0, 3), // 缺 cp2
  ]), /不得跳号/);

  // 某通道先见 cp3、再见该通道未收过的 cp1：编号回退（cp1/cp2/cp3 全局连续，
  // 且对该通道不是重复屏障，须命中回退检查）
  assert.throws(() => validateEvents([
    D('a', 0, 0), D('b', 1, 0),
    B('p1', 1, 1), B('p2', 1, 2),
    B('q3', 0, 3),
    B('back', 0, 1),
  ]), (e) => e.eventId === 'back' && /回退/.test(e.message));
});

test('校验：序号非严格递增定位事件', () => {
  assert.throws(() => validateEvents([
    D('a', 0, 5), D('b', 1, 0), D('c', 0, 3),
  ]), (e) => e.eventId === 'c' && /严格递增/.test(e.message));
});

test('恢复后从快照之后继续，缓存不重复计入', () => {
  // 先跑一遍封存 cp1
  const events = [
    D('a', 0, 0), D('b', 1, 0),
    B('p0', 0, 1),
    D('c', 0, 1),
    B('p1', 1, 1), // 封存，缓存 c 并入快照，inputIndex=4
    D('d', 0, 2),
  ];
  const a = new Aligner(2);
  const out = feed(a, events);
  const snap = { ...out[4].snapshot, published: true };
  assert.deepEqual(snap.totals, [0 + 1, 0]);

  // 模拟重开：恢复快照，nextInputIndex=5
  const a2 = new Aligner(2, snap);
  assert.equal(a2.nextInputIndex, 5);
  assert.deepEqual(a2.totals, [1, 0]);
  // 处理 inputIndex 5 的新数据，ch0 期望 seq 2（缓存的 #1 已提交）
  a2.handle(D('d', 0, 2), 5);
  assert.deepEqual(a2.totals, [1 + 2, 0]);
  // 若错误地把缓存 #1 再放一遍会被判重复
  assert.throws(() => a2.handle(D('replay', 0, 1), 6), /重复计入|错误释放/);
});
