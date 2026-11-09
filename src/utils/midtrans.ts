import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

// F10: Virtual Account lewat Midtrans Core API. Sandbox kecuali MIDTRANS_IS_PRODUCTION=true
// (awalan key tidak bisa dipakai: key sandbox akun baru juga berawalan "Mid-server-").
export const BANK_VA = ["bca", "bni", "bri"] as const;
export type BankVa = (typeof BANK_VA)[number];

const produksi = () => env.MIDTRANS_IS_PRODUCTION === "true";
const host = () => (produksi() ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com");
const hostSnap = () => (produksi() ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com");

async function panggil(url: string, body?: unknown): Promise<Record<string, any>> {
  const key = env.MIDTRANS_SERVER_KEY;
  if (!key) throw new AppError(503, "SERVICE_UNAVAILABLE", "Pembayaran online belum diaktifkan.");
  const res = await fetch(url, {
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
  let r = await panggil(`${host()}/v2/charge`, {
    payment_type: "bank_transfer",
    transaction_details: { order_id: code, gross_amount: amount },
    bank_transfer: { bank },
    custom_expiry: { expiry_duration: menit, unit: "minute" },
  });
  if (r.status_code === "406") r = await panggil(`${host()}/v2/${encodeURIComponent(code)}/status`);
  const va = r.va_numbers?.[0];
  if (!["200", "201"].includes(r.status_code) || !r.transaction_id || !va?.va_number) {
    console.error(`Midtrans charge ${code} gagal: ${r.status_code} ${r.status_message}`);
    throw new AppError(502, "BAD_GATEWAY", "Gagal membuat Virtual Account. Coba lagi.");
  }
  return { transaction_id: String(r.transaction_id), bank: String(va.bank), va_number: String(va.va_number) };
}

// F21: halaman bayar Snap (QRIS, e-wallet, VA) untuk pesanan meja; kartu kredit tidak dibuka (alur capture/fraud).
// Masa berlaku = sisa hold pesanan; `kembali` = halaman status pesanan di web setelah bayar.
export async function buatSnap(code: string, amount: number, menit: number, kembali: string) {
  const r = await panggil(`${hostSnap()}/snap/v1/transactions`, {
    transaction_details: { order_id: code, gross_amount: amount },
    expiry: { unit: "minute", duration: menit },
    callbacks: { finish: kembali },
    enabled_payments: ["other_qris", "gopay", "shopeepay", "bca_va", "bni_va", "bri_va"],
  });
  if (!r.token || !r.redirect_url) {
    console.error(`Midtrans Snap ${code} gagal: ${JSON.stringify(r.error_messages ?? r).slice(0, 300)}`);
    throw new AppError(502, "BAD_GATEWAY", "Gagal membuka halaman pembayaran. Coba lagi.");
  }
  return { redirect_url: String(r.redirect_url) };
}

// Notifikasi sah bila signature_key = SHA512(order_id + status_code + gross_amount + server key)
export function notifikasiSah(n: Record<string, unknown>): boolean {
  const key = env.MIDTRANS_SERVER_KEY;
  if (!key || typeof n.signature_key !== "string") return false;
  const harap = Buffer.from(createHash("sha512").update(`${n.order_id}${n.status_code}${n.gross_amount}${key}`).digest("hex"));
  const kirim = Buffer.from(n.signature_key);
  return harap.length === kirim.length && timingSafeEqual(harap, kirim);
}
