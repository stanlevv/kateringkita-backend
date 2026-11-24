import { createHash } from "node:crypto";
import request from "supertest";
import { vi } from "vitest";
import app from "../../src/app";

// Notifikasi Midtrans bertanda tangan sama dengan Midtrans: SHA512(order_id + status_code + gross_amount + key).
// Cek ulang pembayaran: server memeriksa ulang lewat Get Status. `honest` = Get Status menjawab isi notifikasi yang sama;
// panggilan fetch lain diteruskan ke stub sebelumnya.
export function sendNotification(notification: Record<string, string>, key: string, honest = true) {
  if (honest) {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith(`/v2/${notification.order_id}/status`)
          ? new Response(JSON.stringify(notification))
          : previousFetch(url, init),
      ),
    );
  }
  const signature_key = createHash("sha512")
    .update(`${notification.order_id}${notification.status_code}${notification.gross_amount}${key}`)
    .digest("hex");
  return request(app)
    .post("/api/v1/payments/midtrans")
    .send({ ...notification, signature_key });
}
