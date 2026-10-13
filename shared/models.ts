// Documented model capabilities (verified against developers.openai.com model
// pages on 2026-10-13). Only reasoning efforts listed on each model page are
// sent; for models not listed here the reasoning parameter is omitted.

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelInfo {
  id: string;
  efforts: ReasoningEffort[];
  documented: boolean;
}

export const DOCUMENTED_MODELS: ModelInfo[] = [
  // $0.10 / 1M input, $0.50 / 1M output
  { id: 'gpt-6-luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh'], documented: true },
  // $2 / 1M input, $10 / 1M output (tool calling only via the Responses API)
  { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh'], documented: true },
];

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function isValidModelId(id: string): boolean {
  return MODEL_ID_RE.test(id);
}

export function buildCatalog(ids: string[]): ModelInfo[] {
  const catalog = [...DOCUMENTED_MODELS];
  for (const id of ids) {
    if (isValidModelId(id) && !catalog.some((m) => m.id === id)) catalog.push({ id, efforts: [], documented: false });
  }
  return catalog;
}

/** Returns the effort to send, or null when the parameter must be omitted. */
export function effectiveEffort(catalog: ModelInfo[], model: string, wanted: ReasoningEffort): ReasoningEffort | null {
  const info = catalog.find((m) => m.id === model);
  if (!info || info.efforts.length === 0) return null;
  if (info.efforts.includes(wanted)) return wanted;
  return info.efforts[0] ?? null;
}
