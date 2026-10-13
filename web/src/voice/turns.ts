import type { TranscriptStore } from './transcript-store.ts';

export type TurnResult =
  | { status: 'final'; text: string; endOfSpeechAt: number; finalAt: number; firstPartialAt: number | null }
  | { status: 'empty' }
  | { status: 'timeout'; text: string }
  | { status: 'cancelled' };

interface Pending {
  itemIds: Set<string>;
  acked: boolean;
  completedAfterCommit: number;
  endOfSpeechAt: number;
  promise: Promise<TurnResult>;
  resolve: (r: TurnResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Commits a captured turn with input_audio_buffer.commit (gpt-live-transcribe
 * has no server VAD) and resolves once every item of that turn has its final
 * transcript. Guarantees: no commit without speech, never two commits for the
 * same turn, finals reconciled by item_id even when they arrive out of order.
 */
export class TurnTracker {
  private pending: Pending | null = null;

  constructor(
    private readonly store: TranscriptStore,
    private readonly send: (event: { type: string }) => void,
    private readonly opts: { finalTimeoutMs: number; now: () => number } = { finalTimeoutMs: 6000, now: () => performance.now() },
  ) {}

  get busy(): boolean {
    return this.pending !== null;
  }

  commit(hasSpeech: boolean, endOfSpeechAt: number): Promise<TurnResult> {
    if (this.pending) return this.pending.promise; // already committing this turn
    const open = this.store.openItems();
    const anyNonFinal = open.some((i) => !i.final);
    if (!hasSpeech && !anyNonFinal) {
      if (open.length === 0) return Promise.resolve({ status: 'empty' });
      // Everything already final (e.g. a late final after a timeout): use it without a new commit.
      const ids = open.map((i) => i.itemId);
      const text = this.store.textFor(ids);
      this.store.assign(ids);
      return Promise.resolve(text ? { status: 'final', text, endOfSpeechAt, finalAt: this.opts.now(), firstPartialAt: null } : { status: 'empty' });
    }

    let resolve!: (r: TurnResult) => void;
    const promise = new Promise<TurnResult>((r) => (resolve = r));
    const timer = setTimeout(() => this.finish('timeout'), this.opts.finalTimeoutMs);
    this.pending = { itemIds: new Set(open.map((i) => i.itemId)), acked: false, completedAfterCommit: 0, endOfSpeechAt, promise, resolve, timer };
    this.send({ type: 'input_audio_buffer.commit' });
    return promise;
  }

  /** Any transcription event for an item. Before the commit is acknowledged, new items belong to this turn. */
  onItemSeen(itemId: string): void {
    if (this.pending && !this.pending.acked) this.pending.itemIds.add(itemId);
  }

  onCommitted(itemId: string): void {
    if (!this.pending || this.pending.acked) return;
    this.pending.itemIds.add(itemId);
    this.pending.acked = true;
    this.check();
  }

  onCompleted(itemId: string): void {
    if (!this.pending) return;
    if (!this.pending.acked) this.pending.itemIds.add(itemId);
    if (this.pending.itemIds.has(itemId)) this.pending.completedAfterCommit++;
    this.check();
  }

  /** Server said the buffer was empty (nothing to commit). */
  onCommitEmpty(): void {
    if (!this.pending) return;
    this.pending.acked = true;
    if ([...this.pending.itemIds].every((id) => this.store.isFinal(id))) this.finish('done');
  }

  cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const p = this.pending;
    this.pending = null;
    p.resolve({ status: 'cancelled' });
  }

  private check(): void {
    const p = this.pending;
    if (!p) return;
    const settled = p.acked || p.completedAfterCommit > 0;
    if (settled && [...p.itemIds].every((id) => this.store.isFinal(id))) this.finish('done');
  }

  private finish(kind: 'done' | 'timeout'): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    const ids = [...p.itemIds];
    const text = this.store.textFor(ids);
    if (kind === 'timeout') {
      // Not authoritative: hand the partial text to the user to edit instead of auto-submitting.
      this.store.assign(ids);
      p.resolve(text ? { status: 'timeout', text } : { status: 'empty' });
      return;
    }
    const firstPartialAt = this.store.firstDeltaAt(ids);
    this.store.assign(ids);
    p.resolve(text ? { status: 'final', text, endOfSpeechAt: p.endOfSpeechAt, finalAt: this.opts.now(), firstPartialAt } : { status: 'empty' });
  }
}
