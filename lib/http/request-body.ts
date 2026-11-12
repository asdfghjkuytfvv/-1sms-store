import type { NextRequest } from "next/server";

type BodyError = { ok: false; status: 400 | 413 | 415; error: string };
type BodyBytes = { ok: true; bytes: Buffer } | BodyError;

async function readBoundedBytes(request: NextRequest, maxBytes: number): Promise<BodyBytes> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, status: 400, error: "طول محتوى الطلب غير صالح." };
    if (Number(contentLength) > maxBytes) return { ok: false, status: 413, error: "حجم الطلب أكبر من الحد المسموح." };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "محتوى الطلب مفقود." };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: "حجم الطلب أكبر من الحد المسموح." };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { ok: false, status: 400, error: "تعذر قراءة محتوى الطلب." };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, bytes: Buffer.concat(chunks, size) };
}

export async function rejectUnexpectedRequestBody(request: NextRequest): Promise<BodyError | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, status: 400, error: "طول محتوى الطلب غير صالح." };
    if (Number(contentLength) > 0) return { ok: false, status: 413, error: "هذا المسار لا يقبل محتوى للطلب." };
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return null;
      if (value.byteLength > 0) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "هذا المسار لا يقبل محتوى للطلب." };
      }
    }
  } catch {
    return { ok: false, status: 400, error: "تعذر قراءة محتوى الطلب." };
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonBody(request: NextRequest, maxBytes: number): Promise<{ ok: true; value: unknown } | BodyError> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
  if (contentType !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) {
    return { ok: false, status: 415, error: "يجب إرسال البيانات بصيغة JSON." };
  }
  const body = await readBoundedBytes(request, maxBytes);
  if (!body.ok) return body;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
    if (!text.trim()) return { ok: false, status: 400, error: "محتوى الطلب مفقود." };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "صيغة JSON غير صالحة." };
  }
}

export async function readMultipartFormData(request: NextRequest, maxBytes: number): Promise<{ ok: true; form: FormData } | BodyError> {
  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType)) {
    return { ok: false, status: 415, error: "يجب إرسال الملف بصيغة multipart/form-data." };
  }
  const body = await readBoundedBytes(request, maxBytes);
  if (!body.ok) return body;
  try {
    const boundedRequest = new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body.bytes),
    });
    return { ok: true, form: await boundedRequest.formData() };
  } catch {
    return { ok: false, status: 400, error: "صيغة الملف المرسل غير صالحة." };
  }
}

export function hasSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
