// Isi file: pemanggil API Midtrans, penyedia pembayaran online (Virtual Account bank, QRIS, e-wallet). Dipakai
// va-payment.service. Semua pembayaran non-tunai lewat Midtrans. Mode sandbox (uang bohongan untuk uji coba) kecuali
// MIDTRANS_IS_PRODUCTION=true; awalan key tidak bisa dipakai untuk menebak mode karena key sandbox akun baru juga
// berawalan "Mid-server-".
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

/** Bank yang bisa dipilih untuk Virtual Account (nomor rekening sementara khusus satu pesanan). */
export const VA_BANKS = ["bca", "bni", "bri"] as const;
/** Salah satu bank di {@link VA_BANKS}. */
export type VaBank = (typeof VA_BANKS)[number];

const isProduction = () => env.MIDTRANS_IS_PRODUCTION === "true";
const apiHost = () => (isProduction() ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com");
const snapHost = () => (isProduction() ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com");

// Memanggil satu endpoint Midtrans (POST bila ada body, GET bila tidak) dengan Server Key, paling lama 10 detik.
// Melempar 503 bila Server Key belum diatur, dan 502 bila Midtrans tidak menjawab atau jawabannya bukan JSON.
async function callMidtrans(url: string, body?: unknown): Promise<Record<string, any>> {
  // 1. Tanpa Server Key, pembayaran online dianggap belum diaktifkan.
  const serverKey = env.MIDTRANS_SERVER_KEY;
  if (!serverKey) throw new AppError(503, "SERVICE_UNAVAILABLE", "Pembayaran online belum diaktifkan.");
  // 2. Kirim permintaan dengan Server Key sebagai kata sandi (Basic auth); gagal tersambung dianggap tidak menjawab.
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
  // 3. Jawaban harus berupa JSON.
  const json = res ? await res.json().catch(() => null) : null;
  if (!json) throw new AppError(502, "BAD_GATEWAY", "Layanan pembayaran tidak menjawab. Coba lagi.");
  return json;
}

/**
 * Menanyakan status transaksi langsung ke Midtrans. Karena dipanggil dengan Server Key milik kita, hasilnya tidak bisa
 * dipalsukan oleh pengirim notifikasi.
 * @param code kode pesanan (dipakai sebagai `order_id` di Midtrans)
 * @returns jawaban mentah Midtrans, antara lain `transaction_status`, `status_code`, `gross_amount`
 * @throws 503 Midtrans belum diaktifkan, 502 Midtrans tidak menjawab
 */
export const getMidtransStatus = (code: string) => callMidtrans(`${apiHost()}/v2/${encodeURIComponent(code)}/status`);

/**
 * Membuat Virtual Account untuk satu pesanan. Satu pesanan hanya punya satu VA (`order_id` = kode pesanan), dan masa
 * berlakunya tidak melewati batas waktu pesanan. Bila VA sudah pernah dibuat (misalnya permintaan sebelumnya putus
 * karena timeout), Midtrans menjawab 406 dan VA yang sudah ada diambil dari status transaksi.
 * @param code    kode pesanan
 * @param amount  jumlah yang harus dibayar, dalam rupiah
 * @param bank    bank tujuan VA
 * @param minutes masa berlaku VA dalam menit
 * @returns id transaksi Midtrans, bank, dan nomor VA
 * @throws 503 Midtrans belum diaktifkan, 502 Midtrans tidak menjawab atau gagal membuat VA
 */
export async function createMidtransVa(code: string, amount: number, bank: VaBank, minutes: number) {
  // 1. Minta Midtrans membuat VA.
  let response = await callMidtrans(`${apiHost()}/v2/charge`, {
    payment_type: "bank_transfer",
    transaction_details: { order_id: code, gross_amount: amount },
    bank_transfer: { bank },
    custom_expiry: { expiry_duration: minutes, unit: "minute" },
  });
  // 2. 406 = VA untuk kode ini sudah ada; ambil dari status transaksi.
  if (response.status_code === "406") response = await getMidtransStatus(code);
  // 3. Pastikan jawaban berisi nomor VA; kalau tidak, catat alasannya di log dan laporkan gagal.
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

/**
 * Membuat pembayaran QRIS langsung di aplikasi. Aplikasi menggambar kode QR sendiri dari `qr_string`; `qr_url` adalah
 * gambar QR dari Midtrans (dipakai simulator sandbox).
 * @param code    kode pesanan
 * @param amount  jumlah yang harus dibayar, dalam rupiah
 * @param minutes masa berlaku QRIS dalam menit
 * @returns id transaksi Midtrans, isi kode QR, dan alamat gambar QR
 * @throws 409 pesanan ini sudah mulai dibayar lewat halaman Snap Midtrans (Midtrans menjawab 406, jadi QRIS baru tidak
 *         bisa dibuat), 503 Midtrans belum diaktifkan, 502 Midtrans tidak menjawab atau gagal membuat QRIS
 */
export async function createMidtransQris(code: string, amount: number, minutes: number) {
  // 1. Minta Midtrans membuat QRIS.
  const response = await callMidtrans(`${apiHost()}/v2/charge`, {
    payment_type: "qris",
    transaction_details: { order_id: code, gross_amount: amount },
    qris: { acquirer: "gopay" },
    custom_expiry: { expiry_duration: minutes, unit: "minute" },
  });
  // 2. 406 = kode pesanan sudah dipakai transaksi lain (pembeli sudah memilih metode di halaman Snap).
  if (response.status_code === "406") {
    throw new AppError(409, "CONFLICT", "Pembayaran pesanan ini sudah dimulai di halaman Midtrans. Lanjutkan di sana.");
  }
  // 3. Ambil alamat gambar QR dari daftar aksi, lalu pastikan semua isi penting ada.
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

/**
 * Membuka halaman bayar Snap: halaman milik Midtrans tempat pembeli memilih QRIS, e-wallet, atau VA. Dipakai pesanan
 * meja dan pre-order. Kartu kredit tidak dibuka karena alurnya berbeda (perlu penarikan dana terpisah dan pemeriksaan
 * penipuan).
 * @param code      kode pesanan
 * @param amount    jumlah yang harus dibayar, dalam rupiah
 * @param minutes   masa berlaku halaman bayar dalam menit (sisa waktu tahan pesanan)
 * @param finishUrl halaman status pesanan di web yang dibuka setelah bayar; boleh kosong (aplikasi mobile), maka
 *                  Midtrans memakai halaman bawaannya
 * @returns alamat halaman bayar Snap (`redirect_url`)
 * @throws 503 Midtrans belum diaktifkan, 502 Midtrans tidak menjawab atau gagal membuka halaman bayar
 */
export async function createSnapPayment(code: string, amount: number, minutes: number, finishUrl?: string) {
  // 1. Minta Midtrans membuat halaman bayar; `callbacks.finish` hanya dikirim bila ada halaman tujuan setelah bayar.
  const response = await callMidtrans(`${snapHost()}/snap/v1/transactions`, {
    transaction_details: { order_id: code, gross_amount: amount },
    expiry: { unit: "minute", duration: minutes },
    ...(finishUrl ? { callbacks: { finish: finishUrl } } : {}),
    enabled_payments: ["other_qris", "gopay", "shopeepay", "bca_va", "bni_va", "bri_va"],
  });
  // 2. Pastikan jawaban berisi alamat halaman bayar; kalau tidak, catat alasannya di log dan laporkan gagal.
  if (!response.token || !response.redirect_url) {
    console.error(`Midtrans Snap ${code} gagal: ${JSON.stringify(response.error_messages ?? response).slice(0, 300)}`);
    throw new AppError(502, "BAD_GATEWAY", "Gagal membuka halaman pembayaran. Coba lagi.");
  }
  return { redirect_url: String(response.redirect_url) };
}

/**
 * Memeriksa signature (tanda tangan) notifikasi pembayaran dari Midtrans, supaya notifikasi palsu dari pihak lain
 * ditolak. Notifikasi sah bila `signature_key` = SHA512(order_id + status_code + gross_amount + kunci rahasia).
 * Sejak 28 Okt 2026 Midtrans memisahkan Signature Secret Key dari Server Key; begitu Server Key baru dibuat atau
 * Signature Secret Key dibuat ulang, keduanya berbeda. Tanpa MIDTRANS_SIGNATURE_KEY dipakai Server Key (akun lama,
 * nilainya masih sama).
 * @param notification isi notifikasi JSON dari Midtrans
 * @returns `true` bila tanda tangannya cocok; `false` bila tidak cocok, tidak ada, atau kunci belum diatur
 */
export function isValidNotification(notification: Record<string, unknown>): boolean {
  // 1. Tanpa kunci atau tanpa tanda tangan, notifikasi langsung dianggap tidak sah.
  const signatureKey = env.MIDTRANS_SIGNATURE_KEY ?? env.MIDTRANS_SERVER_KEY;
  if (!signatureKey || typeof notification.signature_key !== "string") return false;
  // 2. Hitung tanda tangan yang seharusnya dari isi notifikasi dan kunci rahasia kita.
  const expectedSignature = Buffer.from(
    createHash("sha512")
      .update(`${notification.order_id}${notification.status_code}${notification.gross_amount}${signatureKey}`)
      .digest("hex"),
  );
  const receivedSignature = Buffer.from(notification.signature_key);
  // 3. Bandingkan dengan tanda tangan yang dikirim. timingSafeEqual butuh waktu yang sama untuk isi apa pun, supaya
  //    penyerang tidak bisa menebak isinya dari lamanya perbandingan.
  return expectedSignature.length === receivedSignature.length && timingSafeEqual(expectedSignature, receivedSignature);
}
