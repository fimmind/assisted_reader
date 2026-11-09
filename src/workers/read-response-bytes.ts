export async function readResponseBytes(response: Response, onProgress: ((downloadedBytes: number) => void) | null): Promise<ArrayBuffer> {
  if (!onProgress) return response.arrayBuffer();
  if (!response.body) throw new Error('Response body is unavailable for streamed download');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloadedBytes += value.byteLength;
    onProgress(downloadedBytes);
  }

  const bytes = new Uint8Array(downloadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
