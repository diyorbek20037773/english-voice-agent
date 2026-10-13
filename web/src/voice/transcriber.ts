// Browser → OpenAI live transcription over WebRTC (audio never touches our server).
// Flow (OpenAI WebRTC guide): ephemeral token from our gateway → RTCPeerConnection
// with one audio track + "oai-events" data channel → POST SDP offer to
// https://api.openai.com/v1/realtime/calls → apply SDP answer.
// The connection stays open across questions; turns are committed manually.
//
// Audio sources:
//   mic    – the device microphone (your voice and whatever the room/speakers play)
//   laptop – the computer's own audio via screen/tab sharing (Zoom, Meet, YouTube…),
//            captured digitally, so it also works with headphones (desktop Chrome/Edge)
//   both   – laptop audio + microphone mixed into one track with Web Audio
import { TranscriptStore } from './transcript-store.ts';
import { TurnTracker, type TurnResult } from './turns.ts';
import { EnergyVad, rmsDb } from './vad.ts';
import type { RealtimeSessionResponse } from '../../../shared/api-types.ts';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'paused' | 'transcribing' | 'error';
export type AudioSource = 'mic' | 'laptop' | 'both';
export type VoiceErrorCode =
  | 'display_denied'
  | 'display_unsupported'
  | 'no_laptop_audio'
  | 'share_ended'
  | 'mic_denied'
  | 'mic_missing'
  | 'mic_busy'
  | 'mic_interrupted'
  | 'insecure_context'
  | 'unsupported'
  | 'token_failed'
  | 'rtc_failed'
  | 'connection_lost'
  | 'transcription_error';

export const VOICE_ERROR_MESSAGES: Record<VoiceErrorCode, string> = {
  display_denied: 'Audio sharing was cancelled. Press Start, choose a tab or Entire screen, and turn on audio sharing.',
  display_unsupported: 'Capturing laptop audio needs Chrome or Edge on a computer. On a phone, use Mic.',
  no_laptop_audio:
    "No laptop audio was shared. Press Start again: choose a Chrome tab and turn on 'Share tab audio', or choose Entire screen and turn on 'Share system audio'.",
  share_ended: 'Laptop audio sharing was stopped. Press Start to share again.',
  mic_denied: 'Microphone access was blocked. Allow microphone access for this site in your browser settings, then press Start.',
  mic_missing: 'No microphone was found on this device.',
  mic_busy: 'The microphone is being used by another app. Close it and press Start again.',
  mic_interrupted: 'Microphone capture was interrupted (for example by a call or by leaving the app). Press Start to reconnect.',
  insecure_context: 'The microphone needs HTTPS. Open the app through its https:// address.',
  unsupported: 'This browser does not support live voice. Use the typed question box instead.',
  token_failed: 'Could not start a voice session.',
  rtc_failed: 'Could not connect to the transcription service. Check your connection and press Start again.',
  connection_lost: 'The voice connection was lost. Press Start to reconnect.',
  transcription_error: 'The transcription service reported an error.',
};

/** Laptop audio capture needs getDisplayMedia with audio: desktop Chrome/Edge (not phones). */
export function canCaptureLaptopAudio(nav: { userAgent: string; mediaDevices?: { getDisplayMedia?: unknown } } = navigator): boolean {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
  return !mobile && typeof nav.mediaDevices?.getDisplayMedia === 'function';
}

const DISPLAY_OPTIONS = {
  // Browsers require a video track for screen sharing; it is never sent anywhere and stops with Stop.
  video: { frameRate: 1 },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  // Chrome/Edge hints: offer "Share system audio", hide this app's own tab.
  systemAudio: 'include',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
} as DisplayMediaStreamOptions;

export interface TurnTimings {
  speechStartAt: number | null;
  firstPartialAt: number | null;
  endOfSpeechAt: number;
  finalAt: number;
}

export interface TranscriberCallbacks {
  onState(state: VoiceState): void;
  onLiveText(items: { text: string; final: boolean }[]): void;
  onSpeaking(speaking: boolean): void;
  /** Microphone input level 0..1, about 10 times per second while listening. */
  onLevel(level: number): void;
  onError(code: VoiceErrorCode, detail?: string): void;
  /** Auto mode: a finished turn with its authoritative final transcript. */
  onAutoTurn(result: TurnResult, timings: TurnTimings | null): void;
}

export class RealtimeTranscriber {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private streams: MediaStream[] = [];
  private sendTrack: MediaStreamTrack | null = null;
  private sender: RTCRtpSender | null = null;
  private audioCtx: AudioContext | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private state: VoiceState = 'idle';
  private paused = false;
  private speechStartAt: number | null = null;
  private levelTick = 0;

  readonly store = new TranscriptStore();
  private readonly turns = new TurnTracker(this.store, (e) => this.send(e), { finalTimeoutMs: 6000, now: () => performance.now() });
  private readonly vad: EnergyVad;

  constructor(
    private readonly getToken: () => Promise<RealtimeSessionResponse>,
    private readonly cb: TranscriberCallbacks,
    private opts: { mode: 'manual' | 'auto'; silenceMs: number; source: AudioSource },
  ) {
    this.vad = new EnergyVad({ silenceMs: opts.silenceMs, minSpeechMs: 300 });
  }

  get active(): boolean {
    return this.state !== 'idle' && this.state !== 'error';
  }

  setMode(mode: 'manual' | 'auto'): void {
    this.opts = { ...this.opts, mode };
  }

  /** Takes effect on the next Start. */
  setSource(source: AudioSource): void {
    this.opts = { ...this.opts, source };
  }

  setSilenceMs(ms: number): void {
    this.opts = { ...this.opts, silenceMs: ms };
    this.vad.setSilenceMs(ms);
  }

  private setState(s: VoiceState): void {
    this.state = s;
    this.cb.onState(s);
  }

  private fail(code: VoiceErrorCode, detail?: string): void {
    this.teardown();
    this.setState('error');
    this.cb.onError(code, detail);
  }

  async start(): Promise<void> {
    if (this.active) return;
    const gen = ++this.generation;
    if (!window.isSecureContext) return this.fail('insecure_context');
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') return this.fail('unsupported');
    this.setState('connecting');
    this.store.reset();
    this.paused = false;

    const source = this.opts.source;

    // Laptop audio first: getDisplayMedia must run while the Start click still counts as a user gesture.
    let display: MediaStream | null = null;
    if (source !== 'mic') {
      if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') return this.fail('display_unsupported');
      try {
        display = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
      } catch (err) {
        const name = (err as DOMException).name;
        return this.fail(name === 'NotAllowedError' || name === 'AbortError' ? 'display_denied' : 'display_unsupported');
      }
      this.streams.push(display);
      if (gen !== this.generation) return this.releaseStreams();
      if (display.getAudioTracks().length === 0) return this.fail('no_laptop_audio');
      // "Stop sharing" in the browser bar ends these tracks.
      for (const t of display.getTracks()) {
        t.addEventListener('ended', () => {
          if (gen === this.generation && this.active) this.fail('share_ended');
        });
      }
    }

    // Microphone permission is requested only now, after the user pressed Start.
    let mic: MediaStream | null = null;
    if (source !== 'laptop') {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (err) {
        const name = (err as DOMException).name;
        return this.fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'mic_denied' : name === 'NotFoundError' ? 'mic_missing' : 'mic_busy');
      }
      this.streams.push(mic);
      if (gen !== this.generation) return this.releaseStreams();
      mic.getAudioTracks()[0]!.addEventListener('ended', () => {
        if (gen === this.generation && this.active) this.fail('mic_interrupted');
      });
    }

    // Audio graph: the VAD analyses everything captured; laptop/both are mixed into one track.
    // Nothing is connected to the speakers, so captured audio is never played back.
    let sendTrack: MediaStreamTrack | null = source === 'mic' ? mic!.getAudioTracks()[0]! : null;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctx();
      void this.audioCtx.resume(); // must start inside the user gesture on iOS
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      const mix = source === 'mic' ? null : this.audioCtx.createMediaStreamDestination();
      for (const captured of [display, mic]) {
        if (!captured) continue;
        const node = this.audioCtx.createMediaStreamSource(captured);
        node.connect(analyser);
        if (mix) node.connect(mix);
      }
      if (mix) sendTrack = mix.stream.getAudioTracks()[0]!;
      const buf = new Float32Array(analyser.fftSize);
      this.vadTimer = setInterval(() => this.vadTick(analyser, buf), 50);
      this.audioCtx.addEventListener('statechange', () => {
        const st = this.audioCtx?.state as string | undefined;
        if (gen === this.generation && this.active && st === 'interrupted') this.fail('mic_interrupted');
      });
    } catch {
      // No Web Audio: VAD (Auto mode) is unavailable; send the first captured track directly.
    }
    const track = sendTrack ?? (display ?? mic)!.getAudioTracks()[0]!;
    this.sendTrack = track;

    let token: RealtimeSessionResponse;
    try {
      token = await this.getToken();
    } catch (err) {
      return this.fail('token_failed', (err as Error).message);
    }
    if (gen !== this.generation) return;

    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.sender = pc.addTrack(track, new MediaStream([track]));
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.addEventListener('open', () => {
        if (gen === this.generation) this.setState(this.paused ? 'paused' : 'listening');
      });
      dc.addEventListener('message', (e) => {
        if (gen === this.generation) this.onServerEvent(e.data);
      });
      dc.addEventListener('close', () => {
        if (gen === this.generation && this.active) this.fail('connection_lost');
      });
      pc.addEventListener('connectionstatechange', () => {
        if (gen !== this.generation) return;
        if (pc.connectionState === 'failed') this.fail('connection_lost');
        else if (pc.connectionState === 'disconnected') {
          this.disconnectTimer ??= setTimeout(() => {
            if (gen === this.generation && pc.connectionState !== 'connected') this.fail('connection_lost');
          }, 4000);
        } else if (pc.connectionState === 'connected' && this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(token.rtcUrl, {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.clientSecret}`, 'Content-Type': 'application/sdp' },
      });
      if (!res.ok) throw new Error(`SDP exchange failed (HTTP ${res.status})`);
      const answerSdp = await res.text();
      if (gen !== this.generation) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (err) {
      if (gen === this.generation) this.fail('rtc_failed', (err as Error).message);
    }
  }

  private vadTick(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): void {
    if (this.paused || this.state === 'connecting') return;
    analyser.getFloatTimeDomainData(buf);
    const now = performance.now();
    const db = rmsDb(buf);
    if (++this.levelTick % 2 === 0) this.cb.onLevel(Math.min(1, Math.max(0, (db + 60) / 50)));
    const ev = this.vad.process(db, now);
    if (!ev) return;
    if (ev.type === 'speech_start') {
      this.speechStartAt ??= ev.at;
      this.cb.onSpeaking(true);
    } else {
      this.cb.onSpeaking(false);
      if (this.opts.mode === 'auto' && this.vad.hasUncommittedSpeech && !this.turns.busy) {
        void this.runTurn(ev.lastVoiceAt).then(({ result, timings }) => this.cb.onAutoTurn(result, timings));
      }
    }
  }

  /** Manual mode "Answer": commit the captured turn and wait for its final transcript. */
  async commitTurn(): Promise<{ result: TurnResult; timings: TurnTimings | null }> {
    if (!this.dc || this.dc.readyState !== 'open') return { result: { status: 'empty' }, timings: null };
    return this.runTurn(performance.now());
  }

  private async runTurn(endOfSpeechAt: number): Promise<{ result: TurnResult; timings: TurnTimings | null }> {
    const gen = this.generation;
    const speechStartAt = this.speechStartAt;
    const hasSpeech = this.vad.hasUncommittedSpeech;
    this.vad.markConsumed();
    this.speechStartAt = null;
    const prev = this.state;
    if (hasSpeech || this.store.openItems().some((i) => !i.final)) this.setState('transcribing');
    const result = await this.turns.commit(hasSpeech, endOfSpeechAt);
    if (gen !== this.generation) return { result: { status: 'cancelled' }, timings: null };
    if (this.state === 'transcribing') this.setState(this.paused ? 'paused' : prev === 'transcribing' ? 'listening' : prev);
    this.emitLive();
    if (result.status !== 'final') return { result, timings: null };
    return {
      result,
      timings: { speechStartAt, firstPartialAt: result.firstPartialAt, endOfSpeechAt: result.endOfSpeechAt, finalAt: result.finalAt },
    };
  }

  /** Drops uncommitted audio and the visible live transcript (e.g. after editing it by hand). */
  clearTurn(): void {
    this.send({ type: 'input_audio_buffer.clear' });
    this.turns.cancel();
    this.store.clearOpen();
    this.vad.markConsumed();
    this.speechStartAt = null;
    this.emitLive();
  }

  pause(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    // Stop sending audio entirely (no silence is streamed or billed while paused).
    void this.sender?.replaceTrack(null).catch(() => {
      if (this.sendTrack) this.sendTrack.enabled = false;
    });
    this.vad.reset();
    this.cb.onSpeaking(false);
    this.cb.onLevel(0);
    this.setState('paused');
  }

  resume(): void {
    if (!this.paused || !this.sendTrack) return;
    const dead = this.deadSource();
    if (dead) return this.fail(dead);
    const track = this.sendTrack;
    this.paused = false;
    track.enabled = true;
    void this.sender?.replaceTrack(track).catch(() => this.fail('mic_interrupted'));
    void this.audioCtx?.resume();
    this.setState('listening');
  }

  /** Call when the page becomes visible again (iOS may have suspended capture). */
  checkHealth(): void {
    if (!this.active) return;
    const dead = this.deadSource();
    const ctxState = this.audioCtx?.state as string | undefined;
    if (dead) this.fail(dead);
    else if (ctxState === 'interrupted') this.fail('mic_interrupted');
    else if (ctxState === 'suspended') void this.audioCtx?.resume();
  }

  /** Which capture ended unexpectedly, if any. */
  private deadSource(): VoiceErrorCode | null {
    if (this.streams.length === 0) return 'mic_interrupted';
    for (const captured of this.streams) {
      const audio = captured.getAudioTracks();
      const isDisplay = captured.getVideoTracks().length > 0;
      if (audio.length === 0 || audio.some((t) => t.readyState === 'ended')) return isDisplay ? 'share_ended' : 'mic_interrupted';
    }
    return null;
  }

  stop(): void {
    this.generation++;
    this.teardown();
    this.setState('idle');
  }

  private teardown(): void {
    this.turns.cancel();
    if (this.vadTimer) clearInterval(this.vadTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.vadTimer = null;
    this.disconnectTimer = null;
    try {
      this.dc?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.dc = null;
    this.pc = null;
    this.sender = null;
    this.releaseStreams();
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.vad.reset();
    this.paused = false;
    this.speechStartAt = null;
    this.cb.onSpeaking(false);
    this.cb.onLevel(0);
  }

  private releaseStreams(): void {
    // Stopping every track releases the microphone and ends screen/audio sharing
    // (the browser's mic and sharing indicators turn off).
    for (const captured of this.streams) captured.getTracks().forEach((t) => t.stop());
    this.streams = [];
    this.sendTrack?.stop();
    this.sendTrack = null;
  }

  private send(event: { type: string }): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  private emitLive(): void {
    this.cb.onLiveText(this.store.openItems().map((i) => ({ text: i.text, final: i.final })));
  }

  private onServerEvent(raw: unknown): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const itemId = typeof ev.item_id === 'string' ? ev.item_id : '';
    const contentIndex = typeof ev.content_index === 'number' ? ev.content_index : 0;
    switch (ev.type) {
      case 'conversation.item.input_audio_transcription.delta':
        this.store.onDelta(itemId, contentIndex, String(ev.delta ?? ''), performance.now());
        this.turns.onItemSeen(itemId);
        this.emitLive();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.store.onCompleted(itemId, contentIndex, String(ev.transcript ?? ''));
        this.turns.onCompleted(itemId);
        this.emitLive();
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.store.onFailed(itemId);
        this.turns.onCompleted(itemId);
        this.emitLive();
        break;
      case 'input_audio_buffer.committed':
        this.store.onCommitted(itemId, typeof ev.previous_item_id === 'string' ? ev.previous_item_id : null);
        this.turns.onCommitted(itemId);
        break;
      case 'error': {
        const err = (ev.error ?? {}) as { code?: string; message?: string };
        if (err.code === 'input_audio_buffer_commit_empty') this.turns.onCommitEmpty();
        else this.cb.onError('transcription_error', err.message ?? err.code);
        break;
      }
      default:
        break;
    }
  }
}
