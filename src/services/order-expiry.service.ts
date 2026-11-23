// Isi file: job latar (berjalan sendiri tiap beberapa detik, bukan karena permintaan dari aplikasi) yang mengubah
// pesanan `holding` (menunggu) yang lewat batas waktu menjadi `expired` dan melepas stoknya. Bukan bagian alur
// routes → handlers: dimulai oleh server.ts, lalu memakai order-status.service (aksi `expire`) untuk tiap pesanan.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { Actor, transitionOrder } from "./order-status.service";

// Hanya server.ts yang memulai penjadwal; test cukup mengimpor app sehingga job ini tidak ikut berjalan di test.
/** Pelaku perubahan status untuk job ini: sistem, tanpa id pengguna (riwayat status mencatat pelaku kosong). */
export const SYSTEM_ACTOR: Actor = { kind: "system" };

/**
 * Satu putaran pembersihan ("sapuan"): ambil paling banyak `limit` pesanan menunggu yang batas waktunya sudah lewat,
 * yang terlama dulu, lalu kadaluarsakan satu per satu. Tiap pesanan memakai transaksi database sendiri (perubahan yang
 * disimpan semua atau dibatalkan semua), jadi satu pesanan gagal tidak menghentikan yang lain. Galat 404/409 berarti
 * pesanan sudah diurus server lain atau aksi lain (misalnya baru saja dibayar), jadi dilewati diam-diam; galat lain
 * hanya dicatat di log.
 * @param limit  jumlah pesanan paling banyak per sapuan (bawaan 100)
 * @param expire cara mengkadaluarsakan satu kode pesanan; bawaannya aksi `expire` oleh sistem, bisa diganti test
 * @returns jumlah pesanan yang berhasil dikadaluarsakan
 */
export async function expireHeldOrders(
  limit = 100,
  expire: (code: string) => Promise<unknown> = (code) =>
    dalamTransaksi((conn) => transitionOrder(conn, code, "expire", SYSTEM_ACTOR)),
): Promise<number> {
  // 1. Cari pesanan menunggu yang sudah lewat batas waktu, terlama dulu.
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT code FROM orders WHERE status = 'holding' AND hold_until <= UTC_TIMESTAMP() ORDER BY hold_until, id LIMIT ?",
    [limit],
  );
  let expiredCount = 0;
  // 2. Kadaluarsakan satu per satu, tidak bersamaan, karena 10 koneksi database dipakai bersama permintaan aplikasi.
  for (const { code } of rows) {
    try {
      await expire(code);
      expiredCount++;
    } catch (error) {
      if (error instanceof AppError && (error.status === 404 || error.status === 409)) continue;
      // shortcut: pesanan yang gagal terus tetap di depan antrean; bila ≥100 pesanan begitu, pesanan lain
      // tertahan — lewati kode yang gagal di sapuan sebelumnya bila terjadi
      console.error(`[kadaluarsa] ${code} gagal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (expiredCount > 0) console.log(`[kadaluarsa] ${expiredCount} pesanan`);
  return expiredCount;
}

// shortcut: setiap server menjalankan sapuannya sendiri (aman karena perubahan status mengunci baris pesanan dengan
// FOR UPDATE); pindahkan ke satu pekerja/cron bila server lebih dari 3
/**
 * Memulai penjadwal sapuan kadaluarsa. Sapuan pertama langsung jalan; sapuan berikutnya dijadwalkan `intervalMs`
 * setelah sapuan sebelumnya selesai, jadi dua sapuan tidak pernah berjalan bersamaan. Galat sapuan dicatat dan
 * penjadwal tetap jalan.
 * @param intervalMs jeda antar sapuan dalam milidetik (bawaan 30 detik)
 * @param sweep      isi satu sapuan; bawaannya {@link expireHeldOrders}, bisa diganti test
 * @returns fungsi untuk menghentikan penjadwal
 */
export function startExpiryJob(
  intervalMs = 30_000,
  sweep: () => Promise<unknown> = () => expireHeldOrders(),
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = () => {
    sweep()
      .catch((error) => console.error("[kadaluarsa] sapuan gagal:", (error as Error).message))
      .finally(() => {
        if (!stopped) timer = setTimeout(run, intervalMs);
      });
  };
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
