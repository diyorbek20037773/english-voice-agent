// Tiny Markdown subset parser for answers: fenced code, headings, lists,
// paragraphs, inline code and bold. Output is plain data rendered by React,
// so model output can never inject HTML.

export type Block =
  | { type: 'code'; lang: string; code: string; closed: boolean }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

export type Inline = { type: 'text' | 'code' | 'bold'; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (/^\s*```\s*$/.test(lines[i]!)) {
          closed = true;
          break;
        }
        body.push(lines[i]!);
      }
      blocks.push({ type: 'code', lang: fence[1] ?? '', code: body.join('\n'), closed });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const ordered = item[2] !== undefined;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'list' && last.ordered === ordered) last.items.push(item[3]!);
      else blocks.push({ type: 'list', ordered, items: [item[3]!] });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1]) out.push({ type: 'code', text: m[1].slice(1, -1) });
    else if (m[2]) out.push({ type: 'bold', text: m[2].slice(2, -2) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
