export async function fetchJson<T>(url: string, timeout = 12000): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": "Hyron/1.0 (New Jersey flood outlook)", Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Data provider returned ${response.status}`);
  const bytes = await boundedBody(response, 3_000_000);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function boundedBody(
  source: { body: ReadableStream<Uint8Array> | null },
  limit: number,
): Promise<Uint8Array> {
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Payload exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
