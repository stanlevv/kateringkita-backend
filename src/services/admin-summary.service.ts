// Isi file: ringkasan beranda panel admin (GET /admin/summary): pesanan hari ini per status, omzet hari ini, jumlah
// toko per status verifikasi dan yang sedang buka, pesanan tahan stok yang hampir habis waktunya, dan 5 log audit
// terbaru. Alurnya routes/admin.ts → handlers/admin.handler.ts → file ini → database. Dua alat waktu di sini juga
// dipakai service lain: getWibDayRange (keranjang checkout) dan isOpenAt (katalog).
//
// WIB = waktu Indonesia barat, UTC+7. Database menyimpan waktu dalam UTC, jadi "hari ini" versi WIB harus diubah dulu
// menjadi rentang waktu UTC.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { listAuditLogs } from "./admin-audit.service";
import { STATUSES } from "./admin-merchant.service";

// Selisih WIB terhadap UTC dan panjang satu hari, dalam milidetik.
const WIB_OFFSET_MS = 7 * 3600e3;
const DAY_MS = 86400e3;

/**
 * Hari kalender WIB yang memuat satu waktu, sebagai rentang waktu UTC `[from, to)`. Contoh: 00.00 WIB = 17.00 UTC hari
 * sebelumnya.
 * @param timeMs waktu dalam milidetik sejak 1970 (contoh `Date.now()`)
 * @returns `{ from, to }`: awal hari WIB itu dan awal hari WIB berikutnya (tidak ikut), keduanya Date
 */
export function getWibDayRange(timeMs: number) {
  const start = Math.floor((timeMs + WIB_OFFSET_MS) / DAY_MS) * DAY_MS - WIB_OFFSET_MS;
  return { from: new Date(start), to: new Date(start + DAY_MS) };
}

// Jam "HH:MM" atau "HH:MM:SS" menjadi jumlah menit sejak tengah malam.
const toMinutes = (hhmm: string) => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
};

/**
 * Mengecek apakah sebuah waktu berada di dalam jam buka toko (menurut jam WIB). Tepat di jam tutup dianggap sudah
 * tutup. Bila jam tutup lebih kecil dari jam buka (contoh 18.00–02.00), jam buka dianggap melewati tengah malam.
 * Aturannya sama dengan pemeriksa jam buka di web, hanya dibalik (web menanyakan "di luar jam buka").
 * @param timeMs    waktu yang dicek, milidetik sejak 1970
 * @param openTime  jam buka "HH:MM" atau "HH:MM:SS"
 * @param closeTime jam tutup "HH:MM" atau "HH:MM:SS"
 * @returns `true` bila waktu itu di dalam jam buka
 */
export function isOpenAt(timeMs: number, openTime: string, closeTime: string): boolean {
  const wibTime = new Date(timeMs + WIB_OFFSET_MS);
  const nowMinutes = wibTime.getUTCHours() * 60 + wibTime.getUTCMinutes();
  const openMinutes = toMinutes(openTime);
  const closeMinutes = toMinutes(closeTime);
  return openMinutes <= closeMinutes
    ? nowMinutes >= openMinutes && nowMinutes < closeMinutes
    : nowMinutes >= openMinutes || nowMinutes < closeMinutes;
}

// Semua status pesanan, supaya status yang tidak punya pesanan hari ini tetap muncul dengan angka 0.
const ORDER_STATUSES = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"] as const;

/**
 * Ringkasan beranda panel admin. Semua tingkat admin boleh membacanya.
 * @param now waktu sekarang dalam milidetik (bisa diganti test)
 * @returns `orders_today` (jumlah pesanan yang dibuat hari ini WIB per status), `revenue_today` (jumlah total pesanan
 *          hari ini yang sudah `completed`), `merchants` (jumlah toko per status verifikasi + `open_now` = toko
 *          terverifikasi yang saklar bukanya menyala dan sedang di jam buka), `holding_expiring_soon` (pesanan tahan
 *          stok yang habis waktunya dalam 60 detik ke depan), dan `recent_logs` (5 log audit terbaru)
 */
export async function getAdminSummary(now = Date.now()) {
  // 1. Pesanan yang dibuat hari ini (WIB) per status, dan omzet dari yang sudah selesai.
  const { from, to } = getWibDayRange(now);
  const [statusRows] = await db.query<RowDataPacket[]>(
    "SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS omzet FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status",
    [from, to],
  );
  const orders_today = Object.fromEntries(ORDER_STATUSES.map((orderStatus) => [orderStatus, 0])) as Record<
    (typeof ORDER_STATUSES)[number],
    number
  >;
  let revenue_today = 0;
  for (const row of statusRows) {
    orders_today[row.status as keyof typeof orders_today] = Number(row.n);
    if (row.status === "completed") revenue_today = Number(row.omzet);
  }
  // 2. Hitung toko per status verifikasi dan yang sedang buka sekarang.
  const [merchantRows] = await db.query<RowDataPacket[]>(
    "SELECT verification_status, is_open, open_time, close_time FROM merchants",
  );
  const merchants = {
    ...Object.fromEntries(STATUSES.map((merchantStatus) => [merchantStatus, 0])),
    open_now: 0,
  } as Record<(typeof STATUSES)[number] | "open_now", number>;
  for (const merchant of merchantRows) {
    merchants[merchant.verification_status as (typeof STATUSES)[number]]++;
    if (
      merchant.verification_status === "verified" &&
      merchant.is_open &&
      isOpenAt(now, String(merchant.open_time), String(merchant.close_time))
    )
      merchants.open_now++;
  }
  // 3. Pesanan yang masih menahan stok dan akan kedaluwarsa dalam satu menit, lalu 5 log audit terbaru.
  const [holdRows] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'holding' AND hold_until >= ? AND hold_until <= ?",
    [new Date(now), new Date(now + 60e3)],
  );
  const { data: recent_logs } = await listAuditLogs({ page: 1, limit: 5 });
  return { orders_today, revenue_today, merchants, holding_expiring_soon: Number(holdRows[0].n), recent_logs };
}
