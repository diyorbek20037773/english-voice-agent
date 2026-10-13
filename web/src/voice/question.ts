// Fast local "is this a complete question?" check for Auto mode. It is a
// heuristic on the final transcript (no extra API call, no added latency), not
// semantic understanding: it only holds back obvious fragments such as
// "Can you explain the difference between" so they are joined with the next
// part of the speech instead of being answered on their own.

const TRAILING_FRAGMENT =
  /\b(and|or|but|so|because|then|the|a|an|of|to|for|with|in|on|at|from|about|like|between|versus|vs|than|is|are|was|were|what|how|why|which|that|if|when|whether|um|uh|er|my|your|our|their)$/i;

export type QuestionAssessment = 'complete' | 'fragment' | 'too_short';

export function assessQuestion(text: string): QuestionAssessment {
  const t = text.trim();
  if (!t) return 'too_short';
  if (/\?\s*$/.test(t)) return 'complete';
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return 'too_short';
  const core = t.replace(/[\s,;:…-]+$/, '').replace(/\.{2,}$/, '');
  if (/[,;:…-]\s*$/.test(t) || /\.\.\.$/.test(t)) return 'fragment';
  if (TRAILING_FRAGMENT.test(core)) return 'fragment';
  return 'complete';
}

export function joinTranscript(a: string, b: string): string {
  return `${a} ${b}`.replace(/\s+/g, ' ').trim();
}
