// Browser-side energy voice activity detection (no dependencies, so nothing
// extra to verify on iPhone Safari). It detects speech/silence by loudness
// only: it is NOT semantic question detection and cannot tell speakers apart.

export interface VadOptions {
  /** End-of-speech silence threshold. */
  silenceMs: number;
  /** Loudness must stay above threshold this long to count as speech start. */
  attackMs?: number;
  /** Speech segments shorter than this are treated as noise. */
  minSpeechMs?: number;
  /** dB above the adaptive noise floor that counts as speech. */
  marginDb?: number;
  /** Absolute minimum speech level in dBFS. */
  minSpeechDb?: number;
  /** Initial window used only to learn the room's noise floor. */
  calibrationMs?: number;
}

export type VadEvent =
  | { type: 'speech_start'; at: number }
  | { type: 'speech_end'; at: number; lastVoiceAt: number; speechMs: number };

export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return 20 * Math.log10(Math.max(rms, 1e-8));
}

export class EnergyVad {
  private noiseDb = -60;
  private speaking = false;
  private aboveSince: number | null = null;
  private lastVoiceAt = 0;
  private speechStartAt = 0;
  /** Voiced time since the last markConsumed(), for "is there anything to commit?" */
  private voicedSinceConsumed = 0;
  private lastFrameAt: number | null = null;
  private calibrationStart: number | null = null;
  private calibrationSum = 0;
  private calibrationFrames = 0;

  constructor(private opts: VadOptions) {}

  setSilenceMs(ms: number): void {
    this.opts = { ...this.opts, silenceMs: ms };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** True when enough speech was heard since the last commit to be worth committing. */
  get hasUncommittedSpeech(): boolean {
    return this.voicedSinceConsumed >= (this.opts.minSpeechMs ?? 300);
  }

  markConsumed(): void {
    this.voicedSinceConsumed = 0;
  }

  reset(): void {
    this.speaking = false;
    this.aboveSince = null;
    this.voicedSinceConsumed = 0;
    this.lastFrameAt = null;
    this.calibrationStart = null;
    this.calibrationSum = 0;
    this.calibrationFrames = 0;
  }

  /** Feed one analysis frame (level in dBFS) at time `now` (ms). */
  process(levelDb: number, now: number): VadEvent | null {
    const frameMs = this.lastFrameAt === null ? 0 : Math.min(200, Math.max(0, now - this.lastFrameAt));
    this.lastFrameAt = now;

    // Learn the room's noise floor first (e.g. a fan or traffic), then detect speech above it.
    this.calibrationStart ??= now;
    if (now - this.calibrationStart < (this.opts.calibrationMs ?? 400)) {
      this.calibrationSum += levelDb;
      this.calibrationFrames++;
      this.noiseDb = this.calibrationSum / this.calibrationFrames;
      return null;
    }
    const margin = this.opts.marginDb ?? 10;
    const threshold = Math.max(this.noiseDb + margin, this.opts.minSpeechDb ?? -50);
    const above = levelDb > threshold;
    const stillVoiced = levelDb > threshold - 3; // hysteresis while speaking

    if (!this.speaking) {
      // Track the noise floor only while not speaking: fast down, slow up.
      const alpha = levelDb < this.noiseDb ? 0.3 : 0.02;
      this.noiseDb = this.noiseDb + alpha * (levelDb - this.noiseDb);
      if (above) {
        this.aboveSince ??= now;
        if (now - this.aboveSince >= (this.opts.attackMs ?? 100)) {
          this.speaking = true;
          this.speechStartAt = this.aboveSince;
          this.lastVoiceAt = now;
          this.voicedSinceConsumed += now - this.aboveSince;
          return { type: 'speech_start', at: this.speechStartAt };
        }
      } else {
        this.aboveSince = null;
      }
      return null;
    }

    if (stillVoiced) {
      this.lastVoiceAt = now;
      this.voicedSinceConsumed += frameMs;
      return null;
    }
    if (now - this.lastVoiceAt >= this.opts.silenceMs) {
      this.speaking = false;
      this.aboveSince = null;
      const speechMs = this.lastVoiceAt - this.speechStartAt;
      return { type: 'speech_end', at: now, lastVoiceAt: this.lastVoiceAt, speechMs };
    }
    return null;
  }
}
