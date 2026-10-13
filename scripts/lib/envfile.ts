import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Reads KEY=VALUE pairs (supports single/double quotes, ignores comments). */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function quote(value: string): string {
  // Single quotes keep "$" literal for Docker Compose and Node's --env-file.
  return /[$\s#"'`\\]/.test(value) && !value.includes("'") ? `'${value}'` : value;
}

/**
 * Updates keys in place (keeping comments and order) and appends missing keys.
 * Creates the file (optionally from a template) when it does not exist.
 */
export function upsertEnvFile(file: string, updates: Record<string, string>, template?: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const base = existsSync(file) ? readFileSync(file, 'utf8') : template && existsSync(template) ? readFileSync(template, 'utf8') : '';
  const lines = base.split(/\r?\n/);
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !pending.has(m[1]!)) return line;
    const key = m[1]!;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${quote(value)}`;
  });
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  for (const [key, value] of pending) next.push(`${key}=${quote(value)}`);
  writeFileSync(file, next.join('\n') + '\n', { mode: 0o600 });
}

export function isPlaceholder(value: string | undefined): boolean {
  return !value || value === 'generated' || value.includes('...') || value.includes('generated-by');
}
