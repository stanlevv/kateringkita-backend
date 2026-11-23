import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

// F10: Virtual Account lewat Midtrans Core API. F26: semua pembayaran non-tunai lewat Midtrans. Sandbox kecuali MIDTRANS_IS_PRODUCTION=true
// (awalan key tidak bisa dipakai: key sandbox akun baru juga berawalan "Mid-server-").
export const VA_BANKS = ["bca", "bni", "bri"] as const;
export type VaBank = (typeof VA_BANKS)[number];

const isProduction = () => env.MIDTRANS_IS_PRODUCTION === "true";
const apiHost = () => (isProduction() ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com");
const snapHost = () => (isProduction() ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com");

async function callMidtrans(url: string, body?: unknown): Promise<Record<string, any>> {
  const serverKey = env.MIDTRANS_SERVER_KEY;
  if (!serverKey) throw new AppError(503, "SERVICE_UNAVAILABLE", "Pembayaran online belum diaktifkan.");
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const json = res ? await res.json().catch(() => null) : null;
  if (!json) throw new AppError(502, "BAD_GATEWAY", "Layanan pembayaran tidak menjawab. Coba lagi.");
  return json;
}

// Get Status: status transaksi menurut Midtrans sendiri (dipanggil dengan Server Key, jadi tidak bisa dipalsukan pengirim notifikasi)
export const getMidtransStatus = (code: string) => callMidtrans(`${apiHost()}/v2/${encodeURIComponent(code)}/status`);

// Satu VA per pesanan (order_id = kode pesanan); masa berlaku VA tidak melewati hold pesanan.
// Charge ulang setelah timeout dijawab 406 (order_id sudah dipakai) → ambil VA dari status transaksi.
export async function createMidtransVa(code: string, amount: number, bank: VaBank, minutes: number) {
  let response = await callMidtrans(`${apiHost()}/v2/charge`, {
    payment_type: "bank_transfer",
    transaction_details: { order_id: code, gross_amount: amount },
    bank_transfer: { bank },
    custom_expiry: { expiry_duration: minutes, unit: "minute" },
  });
  if (response.status_code === "406") response = await getMidtransStatus(code);
  const virtualAccount = response.va_numbers?.[0];
  if (!["200", "201"].includes(response.status_code) || !response.transaction_id || !virtualAccount?.va_number) {
    console.error(`Midtrans charge ${code} gagal: ${response.status_code} ${response.status_message}`);
    throw new AppError(502, "BAD_GATEWAY", "Gagal membuat Virtual Account. Coba lagi.");
  }
  return {
    transaction_id: String(response.transaction_id),
    bank: String(virtualAccount.bank),
    va_number: String(virtualAccount.va_number),
  };
}

// QRIS langsung di aplikasi (Core API): aplikasi menggambar qr_string sendiri; qr_url = gambar QR dari Midtrans (simulator sandbox).
// 406 = order_id sudah dipakai transaksi lain (pembeli sudah memilih metode di halaman Snap) → tidak bisa dibuat QRIS baru.
export async function createMidtransQris(code: string, amount: number, minutes: number) {
  const response = await callMidtrans(`${apiHost()}/v2/charge`, {
    payment_type: "qris",
    transaction_details: { order_id: code, gross_amount: amount },
    qris: { acquirer: "gopay" },
    custom_expiry: { expiry_duration: minutes, unit: "minute" },
  });
  if (response.status_code === "406") {
    throw new AppError(409, "CONFLICT", "Pembayaran pesanan ini sudah dimulai di halaman Midtrans. Lanjutkan di sana.");
  }
  const qrUrl = (response.actions as { name?: string; url?: string }[] | undefined)?.find(
    (action) => action.name === "generate-qr-code",
  )?.url;
  if (!["200", "201"].includes(response.status_code) || !response.transaction_id || !response.qr_string || !qrUrl) {
    console.error(`Midtrans QRIS ${code} gagal: ${response.status_code} ${response.status_message}`);
    throw new AppError(502, "BAD_GATEWAY", "Gagal membuat QRIS. Coba lagi.");
  }
  return {
    transaction_id: String(response.transaction_id),
    qr_string: String(response.qr_string),
    qr_url: String(qrUrl),
  };
}

// F21/F26: halaman bayar Snap (QRIS, e-wallet, VA) untuk pesanan meja dan pre-order; kartu kredit tidak dibuka (alur capture/fraud).
// Masa berlaku = sisa hold pesanan; `kembali` = halaman status di web setelah bayar (aplikasi mobile tanpa `kembali`: URL bawaan Midtrans).
export async function createSnapPayment(code: string, amount: number, minutes: number, finishUrl?: string) {
  const response = await callMidtrans(`${snapHost()}/snap/v1/transactions`, {
    transaction_details: { order_id: code, gross_amount: amount },
    expiry: { unit: "minute", duration: minutes },
    ...(finishUrl ? { callbacks: { finish: finishUrl } } : {}),
    enabled_payments: ["other_qris", "gopay", "shopeepay", "bca_va", "bni_va", "bri_va"],
  });
  if (!response.token || !response.redirect_url) {
    console.error(`Midtrans Snap ${code} gagal: ${JSON.stringify(response.error_messages ?? response).slice(0, 300)}`);
    throw new AppError(502, "BAD_GATEWAY", "Gagal membuka halaman pembayaran. Coba lagi.");
  }
  return { redirect_url: String(response.redirect_url) };
}

// Notifikasi sah bila signature_key = SHA512(order_id + status_code + gross_amount + Signature Secret Key).
// Sejak 28 Okt 2026 Midtrans memisahkan Signature Secret Key dari Server Key; begitu Server Key baru dibuat
// atau Signature Secret Key diregenerasi, keduanya berbeda. Tanpa MIDTRANS_SIGNATURE_KEY: Server Key (akun lama, nilainya masih sama).
export function isValidNotification(notification: Record<string, unknown>): boolean {
  const signatureKey = env.MIDTRANS_SIGNATURE_KEY ?? env.MIDTRANS_SERVER_KEY;
  if (!signatureKey || typeof notification.signature_key !== "string") return false;
  const expectedSignature = Buffer.from(
    createHash("sha512")
      .update(`${notification.order_id}${notification.status_code}${notification.gross_amount}${signatureKey}`)
      .digest("hex"),
  );
  const receivedSignature = Buffer.from(notification.signature_key);
  return expectedSignature.length === receivedSignature.length && timingSafeEqual(expectedSignature, receivedSignature);
}
