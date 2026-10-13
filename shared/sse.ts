// Minimal Server-Sent Events encoder (server) and incremental parser (browser).
// The parser accepts arbitrary string fragments, so callers must decode bytes
// with a streaming TextDecoder before feeding text in.

export interface SseMessage {
  event: string;
  data: string;
}

export function encodeSse(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  // JSON.stringify never emits raw newlines, so one data line is enough.
  return `event: ${event}\ndata: ${json}\n\n`;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private dataLines: string[] = [];

  /** Feed a text fragment; returns every message completed by it. */
  push(fragment: string): SseMessage[] {
    this.buffer += fragment;
    const out: SseMessage[] = [];
    let newline: number;
    while ((newline = this.nextLineBreak()) !== -1) {
      let line = this.buffer.slice(0, newline);
      // Treat CRLF as one break.
      const skip = this.buffer[newline] === '\r' && this.buffer[newline + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(newline + skip);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.dataLines.length > 0) {
          out.push({ event: this.event || 'message', data: this.dataLines.join('\n') });
        }
        this.event = '';
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue; // comment / heartbeat
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.dataLines.push(value);
    }
    return out;
  }

  private nextLineBreak(): number {
    const n = this.buffer.indexOf('\n');
    const r = this.buffer.indexOf('\r');
    if (r === -1) return n;
    // A lone trailing '\r' may be the first half of CRLF; wait for more input.
    if (r === this.buffer.length - 1) return n === -1 ? -1 : Math.min(n, r);
    if (n === -1) return r;
    return Math.min(n, r);
  }
}
