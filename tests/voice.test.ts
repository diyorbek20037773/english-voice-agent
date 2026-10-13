import { describe, expect, it, vi } from 'vitest';
import { TranscriptStore } from '../web/src/voice/transcript-store.ts';
import { TurnTracker } from '../web/src/voice/turns.ts';
import { EnergyVad } from '../web/src/voice/vad.ts';
import { assessQuestion } from '../web/src/voice/question.ts';

describe('TranscriptStore', () => {
  it('replaces partial text with the authoritative final transcript', () => {
    const s = new TranscriptStore();
    s.onDelta('item_1', 0, 'what is a hash');
    s.onDelta('item_1', 0, ' mop');
    expect(s.openItems()[0]).toEqual({ itemId: 'item_1', text: 'what is a hash mop', final: false });
    s.onCompleted('item_1', 0, 'What is a hash map?');
    expect(s.openItems()[0]).toEqual({ itemId: 'item_1', text: 'What is a hash map?', final: true });
    s.onDelta('item_1', 0, ' late partial');
    expect(s.openItems()[0]!.text).toBe('What is a hash map?');
  });

  it('keeps spoken order when finals arrive out of order', () => {
    const s = new TranscriptStore();
    s.onDelta('item_a', 0, 'first part');
    s.onDelta('item_b', 0, 'second part');
    s.onCommitted('item_b', 'item_a');
    s.onCompleted('item_b', 0, 'Second part.');
    s.onCompleted('item_a', 0, 'First part.');
    expect(s.textFor(['item_b', 'item_a'])).toBe('First part. Second part.');
  });

  it('reorders by previous_item_id when an item was first seen late', () => {
    const s = new TranscriptStore();
    s.onCompleted('item_2', 0, 'world');
    s.onCompleted('item_1', 0, 'hello');
    s.onCommitted('item_2', 'item_1');
    expect(s.textFor(['item_1', 'item_2'])).toBe('hello world');
  });

  it('reconciles by content_index', () => {
    const s = new TranscriptStore();
    s.onDelta('i', 1, 'B-partial');
    s.onDelta('i', 0, 'A-partial ');
    s.onCompleted('i', 1, 'B');
    expect(s.openItems()[0]!.text).toBe('A-partial B');
  });
});

describe('TurnTracker', () => {
  const setup = () => {
    const store = new TranscriptStore();
    const sent: string[] = [];
    const turns = new TurnTracker(store, (e) => sent.push(e.type), { finalTimeoutMs: 1000, now: () => 1000 });
    return { store, sent, turns };
  };

  it('does not commit when there is no speech', async () => {
    const { sent, turns } = setup();
    expect(await turns.commit(false, 0)).toEqual({ status: 'empty' });
    expect(sent).toEqual([]);
  });

  it('commits once and waits for the final transcript', async () => {
    const { store, sent, turns } = setup();
    store.onDelta('item_1', 0, 'explain closures');
    const p = turns.commit(true, 500);
    const again = turns.commit(true, 600); // double-press does not commit twice
    expect(sent).toEqual(['input_audio_buffer.commit']);
    turns.onCommitted('item_1');
    store.onCompleted('item_1', 0, 'Explain closures in JavaScript.');
    turns.onCompleted('item_1');
    const r = await p;
    expect(r).toMatchObject({ status: 'final', text: 'Explain closures in JavaScript.', endOfSpeechAt: 500 });
    expect(await again).toBe(r);
    expect(store.openItems()).toEqual([]); // assigned: not repeated next turn
  });

  it('waits for every item of the turn even when finals arrive out of order', async () => {
    const { store, turns } = setup();
    store.onDelta('a', 0, 'how does');
    const p = turns.commit(true, 0);
    store.onDelta('b', 0, 'garbage collection work');
    turns.onItemSeen('b');
    turns.onCommitted('b');
    store.onCompleted('b', 0, 'garbage collection work?');
    turns.onCompleted('b');
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // 'a' is not final yet
    store.onCompleted('a', 0, 'How does');
    turns.onCompleted('a');
    expect(await p).toMatchObject({ status: 'final', text: 'How does garbage collection work?' });
  });

  it('times out without a final and returns the partial text for editing', async () => {
    vi.useFakeTimers();
    const { store, turns } = setup();
    store.onDelta('x', 0, 'unfinished partial');
    const p = turns.commit(true, 0);
    vi.advanceTimersByTime(1001);
    expect(await p).toEqual({ status: 'timeout', text: 'unfinished partial' });
    vi.useRealTimers();
  });

  it('treats a server "commit empty" error as no speech', async () => {
    const { turns } = setup();
    const p = turns.commit(true, 0);
    turns.onCommitEmpty();
    expect(await p).toEqual({ status: 'empty' });
  });
});

describe('EnergyVad', () => {
  let t = 0;
  const run = (vad: EnergyVad, frames: [number, number][]) => {
    const events: string[] = [];
    for (const [db, ms] of frames) {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) {
        const e = vad.process(db, (t += 50));
        if (e) events.push(e.type);
      }
    }
    return events;
  };

  it('detects speech and ends it after the configured silence', () => {
    const vad = new EnergyVad({ silenceMs: 800, minSpeechMs: 300 });
    const events = run(vad, [
      [-70, 1000],
      [-25, 1200],
      [-70, 700],
    ]);
    expect(events).toEqual(['speech_start']);
    expect(run(vad, [[-70, 200]])).toEqual(['speech_end']);
    expect(vad.hasUncommittedSpeech).toBe(true);
    vad.markConsumed();
    expect(vad.hasUncommittedSpeech).toBe(false);
  });

  it('ignores steady background noise and short clicks', () => {
    const vad = new EnergyVad({ silenceMs: 800, minSpeechMs: 300 });
    expect(run(vad, [[-45, 3000]])).toEqual([]);
    expect(run(vad, [[-15, 50], [-45, 1000]])).toEqual([]);
    expect(vad.hasUncommittedSpeech).toBe(false);
  });
});

describe('assessQuestion', () => {
  it.each([
    ['What is a closure?', 'complete'],
    ['Explain the CAP theorem', 'complete'],
    ['Can you explain the difference between', 'fragment'],
    ['How would you design a cache and', 'fragment'],
    ['Tell me about,', 'fragment'],
    ['Okay', 'too_short'],
    ['Hmm yes', 'too_short'],
  ])('%s → %s', (text, expected) => {
    expect(assessQuestion(text)).toBe(expected);
  });
});
