import { createHash } from "node:crypto";
import request from "supertest";
import { vi } from "vitest";
import app from "../../src/app";

// Notifikasi Midtrans bertanda tangan sama dengan Midtrans: SHA512(order_id + status_code + gross_amount + key).
// AUD-23: server memeriksa ulang lewat Get Status. `jujur` = Get Status menjawab isi notifikasi yang sama;
// panggilan fetch lain diteruskan ke stub sebelumnya.
export function kirimNotif(n: Record<string, string>, key: string, jujur = true) {
  if (jujur) {
    const sebelum = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith(`/v2/${n.order_id}/status`) ? new Response(JSON.stringify(n)) : sebelum(url, init)));
  }
  const signature_key = createHash("sha512").update(`${n.order_id}${n.status_code}${n.gross_amount}${key}`).digest("hex");
  return request(app).post("/api/v1/payments/midtrans").send({ ...n, signature_key });
}
