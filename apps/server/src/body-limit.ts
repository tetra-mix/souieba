/**
 * 本文の大きさの上限（hono/body-limit とほぼ同じ）。
 * hono の実装は、上限を超えたときに読みかけの本文を放ったまま応答するので、Workers では応答のあとに
 * 呼び出し元（入口の Worker）が本文を送り続け、「Can't read from request stream after response has been sent」になる。
 * 断るときは、残りの本文を（DRAIN_LIMIT まで）読み捨ててから応答する。読み捨てきれないほど大きければ、読み取りを取り消す。
 */
import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.ts";

const tooLarge = () => new ApiError(413, "payload_too_large", "リクエストが大きすぎます");

/** 断る前に読み捨てる上限。Workers では入口（edge.ts）が Content-Length で 256KB を超える要求を弾くので、たいていはここに収まる */
const DRAIN_LIMIT = 1024 * 1024;

async function discard(reader: ReadableStreamDefaultReader<Uint8Array>, alreadyRead: number): Promise<void> {
  let size = alreadyRead;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.length;
      if (size > DRAIN_LIMIT) {
        await reader.cancel();
        return;
      }
    }
  } catch {}
}

export function bodyLimit(maxSize: number): MiddlewareHandler {
  return async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();
    const length = c.req.raw.headers.get("content-length");
    if (length !== null && !c.req.raw.headers.has("transfer-encoding")) {
      if (Number.parseInt(length, 10) > maxSize) {
        await discard(body.getReader(), 0);
        throw tooLarge();
      }
      return next();
    }
    // Content-Length のない（chunked の）本文は、読みながら数えて、上限を超えたところで打ち切る
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxSize) {
        await discard(reader, size);
        throw tooLarge();
      }
      chunks.push(value);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    c.req.raw = new Request(c.req.raw, { body: stream, duplex: "half" } as RequestInit);
    return next();
  };
}
