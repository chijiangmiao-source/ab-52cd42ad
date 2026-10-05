// 回放器：在捕获顺序时间线上驱动 Aligner，模拟 Worker 内持久化与崩溃恢复。
//
// 持久化顺序（每个检查点封存时严格三阶段，全部完成才算“发布”）：
//   1) intent   写入检查点意图 { cp, inputIndex }
//   2) snapshot 写入快照与输入序号（published=false）
//   3) publish  发布标记（published=true，latest 指针指向该 cp）
//
// 崩溃（fault）：清空本次进程内对齐器，storage.crash() 抹掉所有未完整
// 发布的片段；重开（reopen）只采用最新“完整发布”的检查点，并把处理
// 指针倒回到 snapshot.inputIndex+1，从日志中原序重放其后的事件，
// 已并入快照的缓存项不会再次经过，杜绝重复计入。
import { Aligner } from './aligner.js';
import { AlignerError } from './events.js';

export class MemoryStorage {
  constructor() {
    this.intents = new Map();
    this.snapshots = new Map();
    this.latest = null; // 已发布的最新 cp
    this.log = [];
  }

  async writeIntent(cp, inputIndex) {
    this.intents.set(cp, { cp, inputIndex, at: Date.now() });
    this.log.push({ op: 'intent', cp });
  }

  async writeSnapshot(cp, snapshot) {
    if (!this.intents.has(cp)) {
      throw new Error(`持久化顺序违例：检查点 ${cp} 缺少 intent 即写 snapshot`);
    }
    this.snapshots.set(cp, { ...snapshot, published: false });
    this.log.push({ op: 'snapshot', cp });
  }

  async publish(cp) {
    const snap = this.snapshots.get(cp);
    if (!snap) throw new Error(`持久化顺序违例：检查点 ${cp} 缺少 snapshot 即 publish`);
    snap.published = true;
    this.latest = cp;
    this.log.push({ op: 'publish', cp });
  }

  latestPublished() {
    if (this.latest === null) return null;
    const snap = this.snapshots.get(this.latest);
    if (!snap || !snap.published) return null;
    return snap;
  }

  // 模拟崩溃：进程内未完成的写入全部丢失，已发布快照保留。
  crash() {
    const removed = [];
    for (const [cp, snap] of this.snapshots) {
      if (!snap.published) {
        removed.push({ cp, stage: this.intents.has(cp) ? 'snapshot' : 'unknown' });
        this.snapshots.delete(cp);
      }
    }
    for (const [cp] of this.intents) {
      const snap = this.snapshots.get(cp);
      if (!snap || !snap.published) {
        if (!snap) removed.push({ cp, stage: 'intent' });
        this.intents.delete(cp);
      }
    }
    if (removed.some((r) => r.stage === 'snapshot' || r.stage === 'intent')) {
      this.log.push({ op: 'crash', removed });
    } else {
      this.log.push({ op: 'crash', removed: [] });
    }
    return removed;
  }

  // 重开时扫描：返回未完成片段（用于页面提示“检测到半完成写入”）
  incompleteArtifacts() {
    const out = [];
    for (const [cp] of this.intents) {
      const snap = this.snapshots.get(cp);
      if (snap && snap.published) continue; // 完整发布的不算
      out.push({ cp, stage: snap && !snap.published ? 'snapshot' : 'intent' });
    }
    return out;
  }
}

export class Replayer {
  constructor(channelCount, storage = new MemoryStorage()) {
    this.channelCount = channelCount;
    this.storage = storage;
  }

  /**
   * @param events 已标准化事件（validateEvents 的输出）
   * @returns {Promise<{steps, checkpoints, error, recovery}>}
   */
  async run(events) {
    const storage = this.storage;
    let aligner = new Aligner(this.channelCount);
    const steps = [];
    const checkpoints = []; // 已发布检查点摘要
    let crashed = false;
    let error = null;

    const push = (step) => {
      steps.push({ seq: steps.length, ...step, state: aligner ? aligner.stateView() : null });
    };

    const seal = async (outcome, triggerEvent, replay) => {
      const cp = outcome.checkpoint;
      const persistence = [];
      // 阶段 1：意图
      await storage.writeIntent(cp, outcome.inputIndex);
      persistence.push({ stage: 'intent', cp, inputIndex: outcome.inputIndex });
      if (!replay && triggerEvent.crashStage === 'intent') {
        const removed = storage.crash();
        persistence.push({ stage: 'crash', removed });
        throw { forcedCrash: true, persistence, outcome };
      }
      // 阶段 2：快照 + 输入序号
      await storage.writeSnapshot(cp, outcome.snapshot);
      persistence.push({ stage: 'snapshot', cp, inputIndex: outcome.inputIndex });
      if (!replay && triggerEvent.crashStage === 'snapshot') {
        const removed = storage.crash();
        persistence.push({ stage: 'crash', removed });
        throw { forcedCrash: true, persistence, outcome };
      }
      // 阶段 3：发布标记
      await storage.publish(cp);
      persistence.push({ stage: 'publish', cp });
      checkpoints.push({
        cp,
        inputIndex: outcome.inputIndex,
        viaEventId: outcome.eventId,
        ranges: outcome.snapshot.ranges,
        bufferedCount: outcome.snapshot.bufferedCount,
        releasedBuffer: outcome.snapshot.releasedBuffer,
        totals: outcome.snapshot.totals,
      });
      return persistence;
    };

    const processOne = async (event, index, { replay }) => {
      let outcome;
      try {
        outcome = aligner.handle(event, index);
      } catch (e) {
        if (e instanceof AlignerError) {
          error = { message: e.message, eventId: e.eventId, kind: e.kind, captureIndex: index, replay };
          push({
            kind: 'error', eventId: event.id, captureIndex: index, replay,
            error, storageLog: storage.log.slice(),
          });
          return false;
        }
        throw e;
      }
      if (outcome.kind === 'sealed') {
        try {
          const persistence = await seal(outcome, event, replay);
          push({
            kind: 'sealed', eventId: event.id, captureIndex: index, replay,
            checkpoint: outcome.checkpoint, persistence,
            snapshot: {
              cp: outcome.snapshot.cp,
              totals: outcome.snapshot.totals,
              lastSeq: outcome.snapshot.lastSeq,
              inputIndex: outcome.snapshot.inputIndex,
              ranges: outcome.snapshot.ranges,
              bufferedCount: outcome.snapshot.bufferedCount,
              releasedBuffer: outcome.snapshot.releasedBuffer,
            },
          });
        } catch (crash) {
          if (crash.forcedCrash) {
            aligner = null;
            crashed = true;
            push({
              kind: 'forced-crash', eventId: event.id, captureIndex: index, replay,
              checkpoint: crash.outcome.checkpoint,
              persistence: crash.persistence,
              state: null,
              storageLog: storage.log.slice(),
            });
            return 'crash';
          }
          throw crash;
        }
      } else {
        push({ kind: outcome.kind, eventId: event.id, captureIndex: index, replay, outcome, storageLog: storage.log.slice() });
      }
      return true;
    };

    // 主扫描：遇到 fault/reopen 是控制事件。
    for (let i = 0; i < events.length; i++) {
      if (error) break;
      const event = events[i];

      if (event.type === 'fault') {
        const removed = storage.crash();
        aligner = null;
        crashed = true;
        steps.push({
          seq: steps.length, kind: 'fault', eventId: event.id, captureIndex: i,
          removedArtifacts: removed, state: null, storageLog: storage.log.slice(),
        });
        continue;
      }

      if (event.type === 'reopen') {
        const incomplete = storage.incompleteArtifacts();
        const snap = storage.latestPublished();
        const recovery = {
          restoredCp: snap ? snap.cp : null,
          resumeIndex: snap ? snap.inputIndex + 1 : 0,
          ignoredIncomplete: incomplete,
          totals: snap ? snap.totals.slice() : new Array(this.channelCount).fill(0),
        };
        aligner = new Aligner(this.channelCount, snap);
        crashed = false;
        steps.push({
          seq: steps.length, kind: 'reopen', eventId: event.id, captureIndex: i,
          recovery, state: aligner.stateView(), storageLog: storage.log.slice(),
        });

        // 从最后完整检查点之后原序重放：重走 resumeIndex..reopen 之前的日志。
        // 窗口内的故障等控制事件同样占用捕获序号，仅推进输入指针。
        const replayTo = i; // reopen 自身位置
        for (let j = recovery.resumeIndex; j < replayTo; j++) {
          if (error) break;
          const re = events[j];
          if (re.type === 'data' || re.type === 'barrier') {
            const r = await processOne(re, j, { replay: true });
            if (r === false || error) break;
          } else {
            aligner.advanceControl(j);
          }
        }
        // reopen 自身占用捕获序号
        if (!error) aligner.advanceControl(i);
        continue;
      }

      if (crashed) {
        // 中断窗口内到达的事件：进程不处理（真实链路中丢失，等待重开后由源端重放）
        steps.push({
          seq: steps.length, kind: 'dropped-outage', eventId: event.id, captureIndex: i,
          state: null, note: '浏览器中断期间事件未被处理，重开后从检查点之后重放',
        });
        continue;
      }

      const r = await processOne(event, i, { replay: false });
      if (r === false) break;
      if (r === 'crash') continue;
    }

    return {
      steps,
      checkpoints,
      error,
      finalState: aligner ? aligner.stateView() : null,
      storageLog: storage.log.slice(),
    };
  }
}
