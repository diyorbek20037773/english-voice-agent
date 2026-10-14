// Fast local "should this be answered now?" check for automatic answering. It is a heuristic on
// the final transcript (no extra API call, no added latency), not semantic understanding:
//   question   → answer now (ends with "?", or starts like an interview prompt: "Tell me…", "How would you…")
//   fragment   → obviously unfinished ("…the difference between"): wait for the rest
//   statement  → a complete non-question sentence: keep as context for the next question
//   too_short  → fillers like "Okay." or "Great, thanks."

const TRAILING_FRAGMENT =
  /\b(and|or|but|so|because|then|the|a|an|of|to|for|with|in|on|at|from|about|like|between|versus|vs|than|is|are|was|were|what|how|why|which|that|if|when|whether|um|uh|er|my|your|our|their)$/i;

// Interview prompts that are questions even without a question mark.
const PROMPT_START =
  /^(what|how|why|when|where|which|who|whom|whose|can|could|would|will|should|do|does|did|have|has|had|is|are|was|were|may|might|tell me|describe|explain|walk me through|talk (me )?(about|through)|give (me )?(an? )?(example|overview|summary)|share|compare|define|list|outline|design|imagine|suppose|let'?s (talk|discuss|say)|i'?d (like|love) to (hear|know|understand)|i want to (hear|know|understand)|i'?m (curious|interested)|help me understand|in your (opinion|experience)|what'?s|how'?s|why'?s)\b/i;

const LEAD_IN = /^((okay|ok|so|well|alright|right|great|good|thanks|thank you|now|and|next|cool|perfect|nice)[\s,.!-]+)+/i;

export type QuestionAssessment = 'question' | 'fragment' | 'statement' | 'too_short';

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isQuestionSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (/\?\s*$/.test(s)) return true;
  const core = s.replace(LEAD_IN, '').trim();
  return core.split(/\s+/).length >= 3 && PROMPT_START.test(core);
}

export function assessQuestion(text: string): QuestionAssessment {
  const t = text.trim();
  if (!t) return 'too_short';
  if (sentences(t).some(isQuestionSentence)) {
    // "How would you design a cache and" is a question that is not finished yet.
    const end = t.replace(/[\s,;:…-]+$/, '');
    if (!/[.!?]$/.test(end) && (TRAILING_FRAGMENT.test(end) || /[,;:…-]\s*$/.test(t))) return 'fragment';
    return 'question';
  }
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return 'too_short';
  const core = t.replace(/[\s,;:…-]+$/, '').replace(/\.{2,}$/, '');
  if (/[,;:…-]\s*$/.test(t) || /\.\.\.$/.test(t) || TRAILING_FRAGMENT.test(core)) return 'fragment';
  return 'statement';
}

/** True when any sentence looks like a question or an interview prompt. */
export function containsQuestion(text: string): boolean {
  return sentences(text).some(isQuestionSentence);
}

export function joinTranscript(a: string, b: string): string {
  return `${a} ${b}`.replace(/\s+/g, ' ').trim();
}

/** Keeps the most recent context, cut at a sentence boundary, so the prompt stays small. */
export function trimContext(text: string, maxChars = 600): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const boundary = tail.search(/(?<=[.!?])\s+/);
  return (boundary > 0 ? tail.slice(boundary) : tail).trim();
}
