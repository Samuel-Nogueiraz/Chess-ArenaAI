const DROPPED_KEY = /authorization|api[-_]?key|bearer|password|secret|typesafe_api_key|cursor_api_key/i;

export function sanitize<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (DROPPED_KEY.test(key)) continue;
      out[key] = walk(child);
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/authorization\s*:\s*bearer\s+\S+/gi, "[redacted]")
      .replace(/bearer\s+\S+/gi, "[redacted]")
      .replace(/authorization/gi, "[redacted]");
  }
  return value;
}

export function exportHasSecret(payload: unknown): boolean {
  const text = JSON.stringify(payload);
  return /authorization/i.test(text) || /bearer\s+(?!\[redacted\])/i.test(text);
}
