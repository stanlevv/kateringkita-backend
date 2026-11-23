import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { listAuditLogs } from "./admin-audit.service";
import { STATUSES } from "./admin-merchant.service";

const WIB_OFFSET_MS = 7 * 3600e3;
const DAY_MS = 86400e3;

/** Hari kalender WIB yang memuat `ms`, sebagai rentang UTC [from, to). */
export function getWibDayRange(timeMs: number) {
  const start = Math.floor((timeMs + WIB_OFFSET_MS) / DAY_MS) * DAY_MS - WIB_OFFSET_MS;
  return { from: new Date(start), to: new Date(start + DAY_MS) };
}

const toMinutes = (hhmm: string) => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
};

/** Sama dengan fe/lib/shell.ts diLuarJamBuka (dibalik): tepat jam tutup = tutup; tutup < buka = lewat tengah malam. */
export function isOpenAt(timeMs: number, openTime: string, closeTime: string): boolean {
  const wibTime = new Date(timeMs + WIB_OFFSET_MS);
  const nowMinutes = wibTime.getUTCHours() * 60 + wibTime.getUTCMinutes();
  const openMinutes = toMinutes(openTime);
  const closeMinutes = toMinutes(closeTime);
  return openMinutes <= closeMinutes
    ? nowMinutes >= openMinutes && nowMinutes < closeMinutes
    : nowMinutes >= openMinutes || nowMinutes < closeMinutes;
}

const ORDER_STATUSES = ["holding", "confirmed", "cooking", "ready", "completed", "cancelled", "expired"] as const;

export async function getAdminSummary(now = Date.now()) {
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
  const [holdRows] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'holding' AND hold_until >= ? AND hold_until <= ?",
    [new Date(now), new Date(now + 60e3)],
  );
  const { data: recent_logs } = await listAuditLogs({ page: 1, limit: 5 });
  return { orders_today, revenue_today, merchants, holding_expiring_soon: Number(holdRows[0].n), recent_logs };
}
