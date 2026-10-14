// RealtimeTranscriber reconnect / 60-minute rotation with fake browser APIs (no real WebRTC).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORCE_ROTATE_AFTER_MS, RealtimeTranscriber, ROTATE_AFTER_MS } from '../web/src/voice/transcriber.ts';
import { TranscriptStore } from '../web/src/voice/transcript-store.ts';
import { TurnTracker } from '../web/src/voice/turns.ts';

class FakeTrack {
  kind = 'audio';
  readyState = 'live';
  enabled = true;
  stopped = false;
  addEventListener() {}
  stop() {
    this.readyState = 'ended';
    this.stopped = true;
  }
}
class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}
class FakeDC extends EventTarget {
  readyState = 'connecting';
  sent: { type: string }[] = [];
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  message(obj: unknown) {
    const e = new Event('message') as Event & { data: string };
    e.data = JSON.stringify(obj);
    this.dispatchEvent(e);
  }
}
class FakePC extends EventTarget {
  static all: FakePC[] = [];
  connectionState = 'new';
  closed = false;
  dc!: FakeDC;
  constructor() {
    super();
    FakePC.all.push(this);
  }
  createDataChannel() {
    this.dc = new FakeDC();
    return this.dc;
  }
  addTrack() {
    return { replaceTrack: async () => {} };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.connectionState = 'connected';
  }
  close() {
    this.closed = true;
    this.dc?.close();
  }
}
class FakeAudioContext extends EventTarget {
  state = 'running';
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createAnalyser() {
    return { fftSize: 1024, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createMediaStreamDestination() {
    return { stream: new FakeStream([new FakeTrack()]) };
  }
}

let mic: FakeTrack;
let offset = 0;

beforeEach(() => {
  FakePC.all = [];
  mic = new FakeTrack();
  offset = 0;
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { userAgent: 'test', mediaDevices: { getUserMedia: async () => new FakeStream([mic]) } });
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('fetch', async () => new Response('v=0 answer', { status: 201 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function make() {
  const states: string[] = [];
  const errors: string[] = [];
  const getToken = vi.fn(async () => ({ clientSecret: 'ek_test', expiresAt: 0, model: 'gpt-live-transcribe', rtcUrl: 'https://example.test/v1/realtime/calls' }));
  const t = new RealtimeTranscriber(
    getToken,
    { onState: (s) => states.push(s), onLiveText() {}, onSpeaking() {}, onLevel() {}, onError: (c) => errors.push(c), onAutoTurn() {} },
    { mode: 'manual', silenceMs: 800, source: 'mic' },
  );
  return { t, states, errors, getToken };
}

describe('RealtimeTranscriber reconnects without dropping the microphone', () => {
  it('reconnects automatically when OpenAI closes the session (e.g. the 60-minute cap)', async () => {
    const { t, states, errors, getToken } = make();
    await t.start();
    FakePC.all[0]!.dc.open();
    expect(states.at(-1)).toBe('listening');

    FakePC.all[0]!.dc.close(); // server ends the session
    await vi.waitFor(() => expect(FakePC.all.length).toBe(2));
    FakePC.all[1]!.dc.open();
    await vi.waitFor(() => expect(states.at(-1)).toBe('listening'));

    expect(states).toContain('reconnecting');
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(FakePC.all[0]!.closed).toBe(true);
    expect(mic.stopped).toBe(false); // no new microphone / screen-share prompt
    expect(errors).toEqual([]);
    t.stop();
    expect(mic.stopped).toBe(true);
  });

  it('rotates to a fresh session after 55 minutes during a pause, keeping the final text', async () => {
    const { t, states, errors, getToken } = make();
    await t.start();
    const old = FakePC.all[0]!;
    old.dc.open();
    old.dc.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', content_index: 0, delta: 'what is a mutex' });

    offset = ROTATE_AFTER_MS + 1000; // session is now older than 55 minutes
    await vi.waitFor(() => expect(old.dc.sent.some((e) => e.type === 'input_audio_buffer.commit')).toBe(true), { timeout: 4000 });
    old.dc.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', content_index: 0, transcript: 'What is a mutex?' });

    await vi.waitFor(() => expect(FakePC.all.length).toBe(2), { timeout: 4000 });
    FakePC.all[1]!.dc.open();
    await vi.waitFor(() => expect(states.at(-1)).toBe('listening'));
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(old.closed).toBe(true);
    expect(t.store.openItems()).toEqual([{ itemId: 'item_1', text: 'What is a mutex?', final: true }]);
    expect(mic.stopped).toBe(false);
    expect(errors).toEqual([]);
    expect(t.sessionAgeMs).not.toBeNull();
    t.stop();
  });

  it('forces rotation before the hard 60-minute limit', () => {
    expect(ROTATE_AFTER_MS).toBeLessThan(FORCE_ROTATE_AFTER_MS);
    expect(FORCE_ROTATE_AFTER_MS).toBeLessThan(60 * 60_000);
  });
});

describe('dropped session helpers', () => {
  it('finalizeOpen keeps partial text and expire hands a pending turn back as editable text', async () => {
    const store = new TranscriptStore();
    const turns = new TurnTracker(store, () => {}, { finalTimeoutMs: 60_000, now: () => 0 });
    store.onDelta('a', 0, 'explain dependency');
    const p = turns.commit(true, 0);
    turns.expire();
    expect(await p).toEqual({ status: 'timeout', text: 'explain dependency' });
    store.onDelta('b', 0, 'injection please');
    store.finalizeOpen();
    expect(store.openItems()).toEqual([{ itemId: 'b', text: 'injection please', final: true }]);
  });
});
