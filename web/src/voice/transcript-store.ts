// Reconciles OpenAI live-transcription events into turns.
// - Partial text arrives as ...transcription.delta (item_id, content_index).
// - The final transcript arrives as ...transcription.completed and REPLACES the
//   partial text for that (item_id, content_index): it is authoritative.
// - Finals for different items may arrive out of order, so items keep their own
//   order (first seen, corrected by input_audio_buffer.committed.previous_item_id).

export interface ItemView {
  itemId: string;
  text: string;
  final: boolean;
}

interface Item {
  itemId: string;
  order: number;
  partial: string[];
  final: (string | undefined)[];
  failed: boolean;
  committed: boolean;
  assigned: boolean; // already submitted as part of a turn (or cleared)
  firstDeltaAt: number | null;
}

export class TranscriptStore {
  private items = new Map<string, Item>();
  private counter = 0;

  private get(itemId: string): Item {
    let it = this.items.get(itemId);
    if (!it) {
      it = { itemId, order: ++this.counter, partial: [], final: [], failed: false, committed: false, assigned: false, firstDeltaAt: null };
      this.items.set(itemId, it);
    }
    return it;
  }

  onDelta(itemId: string, contentIndex: number, delta: string, now = Date.now()): void {
    const it = this.get(itemId);
    if (it.final[contentIndex] !== undefined) return; // final already arrived; ignore late partials
    it.partial[contentIndex] = (it.partial[contentIndex] ?? '') + delta;
    if (it.firstDeltaAt === null && delta.trim() !== '') it.firstDeltaAt = now;
  }

  onCompleted(itemId: string, contentIndex: number, transcript: string): void {
    const it = this.get(itemId);
    it.final[contentIndex] = transcript;
  }

  /** Marks an item as failed: treated as final with no text. */
  onFailed(itemId: string): void {
    const it = this.get(itemId);
    it.failed = true;
  }

  onCommitted(itemId: string, previousItemId: string | null | undefined): void {
    const it = this.get(itemId);
    it.committed = true;
    if (previousItemId) {
      const prev = this.items.get(previousItemId);
      if (prev && it.order <= prev.order) it.order = prev.order + 0.5;
    }
  }

  has(itemId: string): boolean {
    return this.items.has(itemId);
  }

  isFinal(itemId: string): boolean {
    const it = this.items.get(itemId);
    return it ? this.done(it) : false;
  }

  /** Final when failed, or when every content part that had partial text also has its final. */
  private done(it: Item): boolean {
    if (it.failed) return true;
    if (!it.final.some((f) => f !== undefined)) return false;
    return it.partial.every((p, i) => p === undefined || it.final[i] !== undefined);
  }

  firstDeltaAt(itemIds: Iterable<string>): number | null {
    let min: number | null = null;
    for (const id of itemIds) {
      const t = this.items.get(id)?.firstDeltaAt ?? null;
      if (t !== null && (min === null || t < min)) min = t;
    }
    return min;
  }

  private textOf(it: Item): string {
    const n = Math.max(it.partial.length, it.final.length);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(it.final[i] ?? (it.failed ? '' : (it.partial[i] ?? '')));
    return parts.join('').trim();
  }

  /** Items not yet submitted, in spoken order. */
  openItems(): ItemView[] {
    return [...this.items.values()]
      .filter((it) => !it.assigned)
      .sort((a, b) => a.order - b.order)
      .map((it) => ({ itemId: it.itemId, text: this.textOf(it), final: this.done(it) }));
  }

  openItemIds(): string[] {
    return this.openItems().map((i) => i.itemId);
  }

  /** Text of the given items in order; finals where available. */
  textFor(itemIds: Iterable<string>): string {
    const set = new Set(itemIds);
    return [...this.items.values()]
      .filter((it) => set.has(it.itemId))
      .sort((a, b) => a.order - b.order)
      .map((it) => this.textOf(it))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Marks items as submitted so they no longer show as the live turn. */
  assign(itemIds: Iterable<string>): void {
    for (const id of itemIds) {
      const it = this.items.get(id);
      if (it) it.assigned = true;
    }
  }

  /** The session ended without finals: keep each open item's partial text as its (non-authoritative) final. */
  finalizeOpen(): void {
    for (const it of this.items.values()) {
      if (it.assigned || this.done(it)) continue;
      if (it.partial.some((p) => p !== undefined && p !== '')) {
        it.partial.forEach((p, i) => {
          if (it.final[i] === undefined) it.final[i] = p ?? '';
        });
      } else {
        it.failed = true;
      }
    }
  }

  clearOpen(): void {
    for (const it of this.items.values()) it.assigned = true;
  }

  reset(): void {
    this.items.clear();
    this.counter = 0;
  }
}
