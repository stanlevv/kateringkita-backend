import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

// F10: Virtual Account lewat Midtrans Core API. Key sandbox ("SB-Mid-server-...") → host sandbox.
export const BANK_VA = ["bca", "bni", "bri"] as const;
export type BankVa = (typeof BANK_VA)[number];

const host = (key: string) => (key.startsWith("SB-") ? "https://api.sandbox.midtrans.com" : "https://api.midtrans.com");

async function panggil(path: string, body?: unknown): Promise<Record<string, any>> {
  const key = env.MIDTRANS_SERVER_KEY;
  if (!key) throw new AppError(503, "SERVICE_UNAVAILABLE", "Pembayaran Virtual Account belum diaktifkan.");
  const res = await fetch(`${host(key)}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const json = res ? await res.json().catch(() => null) : null;
  if (!json) throw new AppError(502, "BAD_GATEWAY", "Layanan pembayaran tidak menjawab. Coba lagi.");
  return json;
}

// Satu VA per pesanan (order_id = kode pesanan); masa berlaku VA tidak melewati hold pesanan.
// Charge ulang setelah timeout dijawab 406 (order_id sudah dipakai) → ambil VA dari status transaksi.
export async function buatVaMidtrans(code: string, amount: number, bank: BankVa, menit: number) {
  let r = await panggil("/v2/charge", {
    payment_type: "bank_transfer",
    transaction_details: { order_id: code, gross_amount: amount },
    bank_transfer: { bank },
    custom_expiry: { expiry_duration: menit, unit: "minute" },
  });
  if (r.status_code === "406") r = await panggil(`/v2/${encodeURIComponent(code)}/status`);
  const va = r.va_numbers?.[0];
  if (!["200", "201"].includes(r.status_code) || !r.transaction_id || !va?.va_number) {
    console.error(`Midtrans charge ${code} gagal: ${r.status_code} ${r.status_message}`);
    throw new AppError(502, "BAD_GATEWAY", "Gagal membuat Virtual Account. Coba lagi.");
  }
  return { transaction_id: String(r.transaction_id), bank: String(va.bank), va_number: String(va.va_number) };
}

// Notifikasi sah bila signature_key = SHA512(order_id + status_code + gross_amount + server key)
export function notifikasiSah(n: Record<string, unknown>): boolean {
  const key = env.MIDTRANS_SERVER_KEY;
  if (!key || typeof n.signature_key !== "string") return false;
  const harap = Buffer.from(createHash("sha512").update(`${n.order_id}${n.status_code}${n.gross_amount}${key}`).digest("hex"));
  const kirim = Buffer.from(n.signature_key);
  return harap.length === kirim.length && timingSafeEqual(harap, kirim);
}
