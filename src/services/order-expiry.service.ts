// Job latar yang mengubah pesanan `holding` lewat batas waktu menjadi `expired` dan melepas stoknya.
// Bukan bagian rute HTTP: dimulai server.ts, lalu memakai order-status.service (aksi `expire`) per pesanan.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { Actor, transitionOrder } from "./order-status.service";

// F08 job kadaluarsa holding (R-03, X-04, C-21; D1–D7). Hanya server.ts yang memulai penjadwal; test mengimpor app saja.
/** Aktor transisi untuk job ini: sistem, tanpa user id (log status memakai actor_user_id NULL). */
export const SYSTEM_ACTOR: Actor = { jenis: "system" };

/**
 * Satu sapuan: ambil maks `limit` pesanan holding yang `hold_until`-nya lewat, terlama dulu (D4), lalu kadaluarsakan
 * satu per satu berurutan. Tiap pesanan transaksi sendiri sehingga satu gagal tidak menghentikan sisanya (D5);
 * galat 404/409 (sudah diproses instance atau aksi lain, D3) dilewati diam-diam, galat lain hanya dicatat.
 *
 * @param limit jumlah pesanan maksimal per sapuan (bawaan 100)
 * @param expire cara mengkadaluarsakan satu kode; bawaan transisi `expire` oleh sistem, diganti test
 * @returns jumlah pesanan yang berhasil dikadaluarsakan
 */
export async function expireHeldOrders(
  limit = 100,
  expire: (code: string) => Promise<unknown> = (code) =>
    dalamTransaksi((c) => transitionOrder(c, code, "expire", SYSTEM_ACTOR)),
): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT code FROM orders WHERE status = 'holding' AND hold_until <= UTC_TIMESTAMP() ORDER BY hold_until, id LIMIT ?",
    [limit],
  );
  let n = 0;
  // berurutan, bukan paralel: pool 10 koneksi dipakai bersama rute
  for (const { code } of rows) {
    try {
      await expire(code);
      n++;
    } catch (e) {
      // 404/409 = sudah ditangani instance atau aksi lain (D3)
      if (e instanceof AppError && (e.status === 404 || e.status === 409)) continue;
      // shortcut: pesanan yang gagal terus tetap di depan antrean; bila ≥100 pesanan begitu, pesanan lain tertahan — lewati kode yang gagal di sapuan sebelumnya bila terjadi
      console.error(`[kadaluarsa] ${code} gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (n > 0) console.log(`[kadaluarsa] ${n} pesanan`);
  return n;
}

// shortcut: setiap instance menyapu sendiri (aman karena FOR UPDATE di transisi); pindah ke satu pekerja/cron bila instance > 3
/**
 * Mulai penjadwal sapuan kadaluarsa: sapuan pertama langsung jalan, sapuan berikutnya dijadwalkan `ms` setelah yang
 * sebelumnya selesai sehingga tidak pernah tumpang tindih (D2). Galat sapuan dicatat, penjadwal tetap jalan.
 *
 * @param ms jeda antar sapuan dalam milidetik (bawaan 30 detik)
 * @param sweep isi satu sapuan; bawaan {@link expireHeldOrders}, diganti test
 * @returns fungsi untuk menghentikan penjadwal
 */
export function startExpiryJob(ms = 30_000, sweep: () => Promise<unknown> = () => expireHeldOrders()): () => void {
  let stopped = false;
  let t: NodeJS.Timeout | undefined;
  // sapuan berikutnya dijadwalkan setelah yang ini selesai → tidak pernah tumpang tindih (D2)
  const run = () => {
    sweep()
      .catch((e) => console.error("[kadaluarsa] sapuan gagal:", (e as Error).message))
      .finally(() => {
        if (!stopped) t = setTimeout(run, ms);
      });
  };
  run();
  return () => {
    stopped = true;
    clearTimeout(t);
  };
}
