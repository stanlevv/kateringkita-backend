import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { Aktor, transisi } from "./pesanan-status.service";

// F08 job kadaluarsa holding (R-03, X-04, C-21; D1–D7). Hanya server.ts yang memulai penjadwal; test mengimpor app saja.
export const SISTEM: Aktor = { jenis: "system" };

// Satu batch per sapuan, terlama dulu (D4); tiap pesanan transaksi sendiri sehingga satu gagal tidak menghentikan sisanya (D5)
export async function kadaluarsakan(
  batas = 100,
  expire: (code: string) => Promise<unknown> = (code) => dalamTransaksi((c) => transisi(c, code, "expire", SISTEM)),
): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT code FROM orders WHERE status = 'holding' AND hold_until <= UTC_TIMESTAMP() ORDER BY hold_until, id LIMIT ?", [batas],
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
export function mulaiJobKadaluarsa(ms = 30_000, sapu: () => Promise<unknown> = () => kadaluarsakan()): () => void {
  let berhenti = false;
  let t: NodeJS.Timeout | undefined;
  // sapuan berikutnya dijadwalkan setelah yang ini selesai → tidak pernah tumpang tindih (D2)
  const jalan = () => {
    sapu().catch((e) => console.error("[kadaluarsa] sapuan gagal:", (e as Error).message)).finally(() => {
      if (!berhenti) t = setTimeout(jalan, ms);
    });
  };
  jalan();
  return () => {
    berhenti = true;
    clearTimeout(t);
  };
}
