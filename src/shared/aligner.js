// 屏障对齐（barrier alignment）核心引擎，纯逻辑、无持久化、无 DOM 依赖。
// 规则：
//  1) 每通道数据序号严格连续递增；
//  2) 某检查点屏障先到一个通道后，该通道后续数据进入缓存，直到全部通道
//     的同名屏障到齐，才封存累计状态，并按捕获原序释放缓存；
//  3) 屏障失配（编号对不上当前对齐中的检查点）、跳号、重复屏障、序号
//     断层、恢复后重复计入，全部抛出 AlignerError 并定位首个事件。
import { AlignerError } from './events.js';

export class Aligner {
  constructor(channelCount, restored = null) {
    this.channelCount = channelCount;
    // 已计入累计状态的每通道累计值与最后序号（封存时含已释放缓存）
    this.totals = new Array(channelCount).fill(0);
    this.committedSeq = new Array(channelCount).fill(null);
    // 已观测（含缓存中尚未计入）的最后序号，用于序号连续性校验
    this.lastSeq = new Array(channelCount).fill(null);
    // 上一封存点已提交序号，切分检查点纳入范围
    this.prevCommittedSeq = new Array(channelCount).fill(null);
    // 当前对齐中的检查点
    this.pendingCp = null;
    this.arrived = new Set();
    this.barrierCp = new Array(channelCount).fill(null);
    this.everSealed = 0;
    // 缓存按全局捕获顺序追加：{ eventId, channel, seq, value, atIndex, reason }
    this.buffer = [];
    // 期望的下一条输入序号（恢复后从快照 inputIndex+1 起）
    this.nextInputIndex = 0;

    if (restored) this.restore(restored);
  }

  restore(snapshot) {
    if (!snapshot || !snapshot.published) {
      throw new AlignerError('只能恢复完整发布的检查点快照', snapshot?.cp ? `cp${snapshot.cp}` : null);
    }
    this.totals = snapshot.totals.slice();
    this.committedSeq = snapshot.lastSeq.slice();
    this.lastSeq = snapshot.lastSeq.slice();
    this.prevCommittedSeq = snapshot.lastSeq.slice();
    this.pendingCp = null;
    this.arrived = new Set();
    this.barrierCp = new Array(this.channelCount).fill(null);
    this.buffer = [];
    this.everSealed = snapshot.cp;
    this.nextInputIndex = snapshot.inputIndex + 1;
  }

  _expectIndex(index) {
    if (index !== this.nextInputIndex) {
      throw new AlignerError(
        `输入序号断层：期望 ${this.nextInputIndex}，实际 ${index}`, null, 'processing'
      );
    }
  }

  // fault/reopen 等控制事件同样占据捕获序号，需要推进指针但不参与对齐
  advanceControl(index) {
    this._expectIndex(index);
    this.nextInputIndex = index + 1;
  }

  /**
   * 处理一个事件（index 为捕获顺序全局序号）。
   * 返回副作用描述：released | buffered | barrier | sealed | noop
   */
  handle(event, index) {
    this._expectIndex(index);
    const advance = () => { this.nextInputIndex = index + 1; };

    if (event.type === 'data') return this._handleData(event, index, advance);
    if (event.type === 'barrier') return this._handleBarrier(event, index, advance);
    advance();
    return { kind: 'noop', eventId: event.id };
  }

  _handleData(event, index, advance) {
    const c = event.channel;
    if (c < 0 || c >= this.channelCount) {
      throw new AlignerError(`数据事件通道 ${c} 超出通道范围`, event.id, 'processing');
    }
    if (this.lastSeq[c] !== null && event.seq !== this.lastSeq[c] + 1) {
      if (event.seq <= this.lastSeq[c]) {
        throw new AlignerError(
          `错误释放/重复计入：通道 ${c} 序号 ${event.seq} 已越过或已计入` +
          `（最后观测 ${this.lastSeq[c]}），继续处理将重复计数`,
          event.id, 'processing'
        );
      }
      throw new AlignerError(
        `通道 ${c} 数据序号跳号：期望 ${this.lastSeq[c] + 1}，实际 ${event.seq}`,
        event.id, 'processing'
      );
    }

    const blockedByBarrier =
      this.pendingCp !== null && this.barrierCp[c] === this.pendingCp;

    if (blockedByBarrier) {
      const waiting = [];
      for (let ch = 0; ch < this.channelCount; ch++) {
        if (!this.arrived.has(ch)) waiting.push(ch);
      }
      const reason =
        `检查点 ${this.pendingCp} 屏障已先到通道 ${c}，序号 ${event.seq} 缓存；` +
        `等待通道 [${waiting.join(', ')}] 的同编号屏障到齐`;
      this.buffer.push({
        eventId: event.id, channel: c, seq: event.seq, value: event.value,
        atIndex: index, reason,
      });
      this.lastSeq[c] = event.seq;
      advance();
      return { kind: 'buffered', eventId: event.id, channel: c, seq: event.seq, reason };
    }

    this.totals[c] += event.value;
    this.committedSeq[c] = event.seq;
    this.lastSeq[c] = event.seq;
    advance();
    return { kind: 'released', eventId: event.id, channel: c, seq: event.seq, value: event.value };
  }

  _handleBarrier(event, index, advance) {
    const c = event.channel;
    const cp = event.checkpoint;

    if (c < 0 || c >= this.channelCount) {
      throw new AlignerError(`屏障事件通道 ${c} 超出通道范围`, event.id, 'processing');
    }
    if (this.barrierCp[c] !== null && cp <= this.barrierCp[c]) {
      throw new AlignerError(
        `通道 ${c} 重复屏障：检查点 ${this.barrierCp[c]} 已接收，又出现检查点 ${cp}`,
        event.id, 'processing'
      );
    }

    if (this.pendingCp === null) {
      const expected = this.everSealed + 1;
      if (cp !== expected) {
        throw new AlignerError(
          `屏障失配/跳号：下一个应对齐检查点 ${expected}，通道 ${c} 却到达检查点 ${cp}`,
          event.id, 'processing'
        );
      }
      this.pendingCp = cp;
    } else if (cp !== this.pendingCp) {
      if (cp > this.pendingCp) {
        throw new AlignerError(
          `屏障跳号：检查点 ${this.pendingCp} 尚未全部对齐（缺通道 ` +
          `[${this._waiting().join(', ')}]），通道 ${c} 提前到达检查点 ${cp}`,
          event.id, 'processing'
        );
      }
      throw new AlignerError(
        `屏障失配：正在对齐检查点 ${this.pendingCp}，通道 ${c} 到达过期屏障 ${cp}`,
        event.id, 'processing'
      );
    }

    this.barrierCp[c] = cp;
    this.arrived.add(c);
    advance();

    if (this.arrived.size === this.channelCount) {
      return this._seal(index, event.id);
    }
    return {
      kind: 'barrier', eventId: event.id, channel: c, checkpoint: cp,
      waitingChannels: this._waiting(),
    };
  }

  _waiting() {
    const w = [];
    for (let ch = 0; ch < this.channelCount; ch++) if (!this.arrived.has(ch)) w.push(ch);
    return w;
  }

  _seal(index, viaEventId) {
    const cp = this.pendingCp;

    // 纳入范围：上一封存点之后、各通道屏障位置之前已直接计入的序号
    const ranges = [];
    for (let c = 0; c < this.channelCount; c++) {
      const fromSeq = this.prevCommittedSeq[c] === null
        ? (this.committedSeq[c] === null ? null : 0)
        : this.committedSeq[c] === null
          ? null
          : this.prevCommittedSeq[c] + 1;
      const toSeq = this.committedSeq[c];
      const items = [];
      if (toSeq !== null && fromSeq !== null) {
        for (let s = fromSeq; s <= toSeq; s++) items.push(s);
      }
      ranges.push({ channel: c, fromSeq, toSeq, items });
    }

    // 封存累计状态：屏障时刻、缓存释放“之前”的状态
    const sealedTotals = this.totals.slice();
    const sealedCommitted = this.committedSeq.slice();

    // 按捕获原序释放缓存（buffer 本身即按全局捕获顺序追加）
    const releasedBuffer = [];
    for (const item of this.buffer) {
      this.totals[item.channel] += item.value;
      this.committedSeq[item.channel] = item.seq;
      releasedBuffer.push({
        eventId: item.eventId, channel: item.channel, seq: item.seq,
        value: item.value, reason: item.reason,
      });
    }
    const bufferedCount = this.buffer.length;

    this.buffer = [];
    this.pendingCp = null;
    this.arrived = new Set();
    this.everSealed = cp;
    this.prevCommittedSeq = this.committedSeq.slice();

    // 发布的快照 = 释放缓存后的完整累计状态；恢复时从 inputIndex+1 继续，
    // 缓存项既已并入快照，倒回重放不会再次经过它们，杜绝重复计入。
    const snapshot = {
      cp,
      published: false,
      totals: this.totals.slice(),
      lastSeq: this.lastSeq.slice(),
      inputIndex: index,
      sealedViaEventId: viaEventId,
      ranges,
      sealedTotals,
      sealedCommitted,
      releasedBuffer,
      bufferedCount,
    };

    return {
      kind: 'sealed',
      checkpoint: cp,
      eventId: viaEventId,
      inputIndex: index,
      snapshot,
    };
  }

  /** 任一步的通道状态视图（供页面逐步查看） */
  stateView() {
    return {
      pendingCp: this.pendingCp,
      arrivedChannels: [...this.arrived].sort((a, b) => a - b),
      waitingChannels: this.pendingCp === null ? [] : this._waiting(),
      nextInputIndex: this.nextInputIndex,
      everSealed: this.everSealed,
      channels: [...Array(this.channelCount).keys()].map((c) => ({
        channel: c,
        total: this.totals[c],
        lastSeq: this.lastSeq[c],
        committedSeq: this.committedSeq[c],
        barrierCp: this.barrierCp[c],
        buffered: this.buffer.filter((b) => b.channel === c).map((b) => ({
          eventId: b.eventId, seq: b.seq, reason: b.reason,
        })),
      })),
      bufferOrder: this.buffer.map((b) => ({
        eventId: b.eventId, channel: b.channel, seq: b.seq, reason: b.reason,
      })),
    };
  }
}
