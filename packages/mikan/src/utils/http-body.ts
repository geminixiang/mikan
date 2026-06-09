import type { IncomingMessage, ServerResponse } from "http";

/**
 * Read and size-limit an HTTP request body.
 *
 * Responds with 413 and destroys the request if the body exceeds `maxBytes`.
 * Resolves with the raw body string on success, or `null` if the size limit
 * was exceeded (the response has already been sent in that case).
 */
export function readRawBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let data = "";
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      data += chunk.toString();
      if (data.length > maxBytes) {
        tooLarge = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        resolve(null);
      }
    });
    req.on("end", () => {
      if (!tooLarge) resolve(data);
    });
    req.on("error", () => {
      if (!tooLarge) resolve(data);
    });
  });
}
