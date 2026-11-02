import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { daftarLog } from "./audit";
import { STATUSES } from "./merchants";

const WIB = 7 * 3600e3;
const HARI = 86400e3;

/** Hari kalender WIB yang memuat `ms`, sebagai rentang UTC [from, to). */
export function rentangHariWib(ms: number) {
  const mulai = Math.floor((ms + WIB) / HARI) * HARI - WIB;
  return { from: new Date(mulai), to: new Date(mulai + HARI) };
}

const menit = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Sama dengan fe/lib/shell.ts diLuarJamBuka (dibalik): tepat jam tutup = tutup; tutup < buka = lewat tengah malam. */
export function sedangBuka(ms: number, buka: string, tutup: string): boolean {
  const w = new Date(ms + WIB);
  const sekarang = w.getUTCHours() * 60 + w.getUTCMinutes();
  const b = menit(buka);
  const t = menit(tutup);
  return b <= t ? sekarang >= b && sekarang < t : sekarang >= b || sekarang < t;
}

const STATUS_PESANAN = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"] as const;

export async function ringkasan(now = Date.now()) {
  const { from, to } = rentangHariWib(now);
  const [perStatus] = await db.query<RowDataPacket[]>(
    "SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS omzet FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status",
    [from, to],
  );
  const orders_today = Object.fromEntries(STATUS_PESANAN.map((s) => [s, 0])) as Record<(typeof STATUS_PESANAN)[number], number>;
  let revenue_today = 0;
  for (const r of perStatus) {
    orders_today[r.status as keyof typeof orders_today] = Number(r.n);
    if (r.status === "completed") revenue_today = Number(r.omzet);
  }
  const [toko] = await db.query<RowDataPacket[]>("SELECT verification_status, is_open, open_time, close_time FROM merchants");
  const merchants = { ...Object.fromEntries(STATUSES.map((s) => [s, 0])), open_now: 0 } as Record<(typeof STATUSES)[number] | "open_now", number>;
  for (const m of toko) {
    merchants[m.verification_status as (typeof STATUSES)[number]]++;
    if (m.verification_status === "verified" && m.is_open && sedangBuka(now, String(m.open_time), String(m.close_time))) merchants.open_now++;
  }
  const [hold] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'holding' AND hold_until >= ? AND hold_until <= ?",
    [new Date(now), new Date(now + 60e3)],
  );
  const { data: recent_logs } = await daftarLog({ page: 1, limit: 5 });
  return { orders_today, revenue_today, merchants, holding_expiring_soon: Number(hold[0].n), recent_logs };
}
