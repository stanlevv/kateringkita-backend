import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { recordAudit, listAuditLogs, withTransaction } from "./admin-audit.service";

export const STATUSES = ["pending", "needs_fix", "verified", "suspended"] as const;
type Status = (typeof STATUSES)[number];

// Transisi K1. `set` = kolom yang berubah (nilai SQL), `cols` = kolom yang dicatat before/after.
type Rule = { action: string; from: Status[]; set: string; cols: string[]; reason?: "note" | "suspend" };
const RULES: Record<string, Rule> = {
  verify: {
    action: "merchant.verify",
    from: ["pending", "needs_fix"],
    set: "verification_status='verified', verified_at=UTC_TIMESTAMP(), verification_note=NULL",
    cols: ["verification_status", "verified_at", "verification_note"],
  },
  "request-fix": {
    action: "merchant.request_fix",
    from: ["pending"],
    set: "verification_status='needs_fix', verification_note=?",
    cols: ["verification_status", "verification_note"],
    reason: "note",
  },
  suspend: {
    action: "merchant.suspend",
    from: ["pending", "needs_fix", "verified"],
    set: "verification_status='suspended', verified_at=NULL, suspended_at=UTC_TIMESTAMP(), suspended_reason=?",
    cols: ["verification_status", "verified_at", "suspended_at", "suspended_reason"],
    reason: "suspend",
  },
  reactivate: {
    action: "merchant.reactivate",
    from: ["suspended"],
    set: "verification_status='verified', verified_at=UTC_TIMESTAMP(), suspended_at=NULL, suspended_reason=NULL",
    cols: ["verification_status", "verified_at", "suspended_at", "suspended_reason"],
  },
  "close-today": {
    action: "merchant.close_today",
    from: ["verified"],
    set: "is_open=FALSE",
    cols: ["is_open"],
  },
};
export const ACTION_NAMES = Object.keys(RULES);

// shortcut: opening_hours hanya cek jam buka < jam tutup (kolom punya default, jadi hampir selalu true); upgrade bila jam buka bisa kosong.
const CHECKLIST_SQL = `
  m.wa_number REGEXP '^08[0-9]{8,11}$' AS chk_wa_valid,
  TRIM(m.address) <> '' AS chk_address,
  EXISTS (SELECT 1 FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id WHERE mp.merchant_id = m.id AND p.is_active) AS chk_pickup_point,
  EXISTS (SELECT 1 FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS chk_active_menu,
  EXISTS (SELECT 1 FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL AND x.image_url IS NOT NULL AND x.image_url <> '') AS chk_menu_with_photo,
  m.open_time < m.close_time AS chk_opening_hours`;
const CHECK_KEYS = ["wa_valid", "address", "pickup_point", "active_menu", "menu_with_photo", "opening_hours"];
const toChecklist = (row: RowDataPacket) =>
  Object.fromEntries(CHECK_KEYS.map((key) => [key, Boolean(row[`chk_${key}`])]));
const isNotChecklistColumn = ([key]: [string, unknown]) => !key.startsWith("chk_");

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

export async function listMerchants(filter: {
  q?: string;
  status?: string;
  open?: string;
  page: number;
  limit: number;
}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status !== undefined) {
    if (!STATUSES.includes(filter.status as Status))
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { status: ["Status tidak dikenal."] });
    where.push("m.verification_status = ?");
    args.push(filter.status);
  }
  if (filter.open !== undefined) {
    if (filter.open !== "0" && filter.open !== "1")
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { open: ["Harus 1 atau 0."] });
    where.push("m.is_open = ?");
    args.push(Number(filter.open));
  }
  if (filter.q) {
    where.push("(LOWER(m.business_name) LIKE LOWER(?) OR m.wa_number LIKE ?)");
    const like = `%${escapeLike(filter.q)}%`;
    args.push(like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, u.full_name AS owner_name, m.wa_number, m.verification_status, m.is_open,
            (SELECT COUNT(*) FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS menu_count,
            m.created_at
     FROM merchants m JOIN users u ON u.id = m.user_id ${whereSql}
     ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  const [counts] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM merchants m ${whereSql}`, args);
  return {
    data: rows.map((row) => ({ ...row, is_open: Boolean(row.is_open), menu_count: Number(row.menu_count) })),
    meta: { page: filter.page, limit: filter.limit, total: Number(counts[0].total) },
  };
}

export async function getVerificationQueue() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, u.full_name AS owner_name, m.wa_number, m.verification_status, m.verification_note, m.created_at,
            ${CHECKLIST_SQL},
            COALESCE(GREATEST(m.updated_at, COALESCE((SELECT MAX(x.updated_at) FROM menus x WHERE x.merchant_id = m.id), m.updated_at))
              > (SELECT MAX(l.created_at) FROM admin_audit_logs l WHERE l.target_type = 'merchant' AND l.target_id = m.id AND l.action = 'merchant.request_fix'), 0) AS updated_after_note
     FROM merchants m JOIN users u ON u.id = m.user_id
     WHERE m.verification_status IN ('pending','needs_fix')
     ORDER BY m.created_at ASC, m.id ASC`,
  );
  return rows.map((row) => {
    const { updated_after_note, ...rest } = row;
    const lean = Object.fromEntries(Object.entries(rest).filter(isNotChecklistColumn));
    return { ...lean, checklist: toChecklist(row), updated_after_note: Boolean(updated_after_note) };
  });
}

export async function getMerchantDetail(id: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.*, u.full_name AS owner_full_name, u.phone AS owner_phone, u.email AS owner_email, u.is_active AS owner_is_active,
            t.name AS merchant_type_name,
            (SELECT COUNT(*) FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS menu_count,
            ${CHECKLIST_SQL}
     FROM merchants m JOIN users u ON u.id = m.user_id JOIN merchant_types t ON t.id = m.merchant_type_id WHERE m.id = ?`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  const merchant = rows[0];
  const [points] = await db.query<RowDataPacket[]>(
    "SELECT p.id, p.name FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id WHERE mp.merchant_id = ? ORDER BY p.name",
    [id],
  );
  const { data: logs } = await listAuditLogs({ page: 1, limit: 10, targetType: "merchant", targetId: String(id) });
  const profile = Object.fromEntries(
    // payout_* (AUD-26): rekening pencairan hanya untuk admin super lewat /payouts, sedangkan detail ini terbuka untuk semua tier
    Object.entries(merchant).filter(
      (entry) => isNotChecklistColumn(entry) && !entry[0].startsWith("owner_") && !entry[0].startsWith("payout_"),
    ),
  );
  return {
    ...profile,
    is_open: Boolean(merchant.is_open),
    menu_count: Number(merchant.menu_count),
    owner: {
      full_name: merchant.owner_full_name,
      phone: merchant.owner_phone,
      email: merchant.owner_email,
      is_active: Boolean(merchant.owner_is_active),
    },
    pickup_points: points,
    checklist: toChecklist(merchant),
    recent_logs: logs,
  };
}

export async function runMerchantAction(adminId: number, id: number, name: string, reason?: string) {
  const rule = RULES[name];
  await withTransaction(async (conn) => {
    const pick = (row: RowDataPacket) => Object.fromEntries(rule.cols.map((column) => [column, row[column]]));
    const [found] = await conn.query<RowDataPacket[]>("SELECT * FROM merchants WHERE id = ? FOR UPDATE", [id]);
    if (!found[0]) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
    if (!rule.from.includes(found[0].verification_status))
      throw new AppError(409, "CONFLICT", "Status penjual sudah berubah.");
    if (name === "close-today" && !found[0].is_open) return; // sudah tutup: tanpa perubahan dan tanpa log
    if (!rule.reason) reason = undefined; // hanya aksi bertanda reason yang memakai alasan (sudah divalidasi)
    await conn.query(`UPDATE merchants SET ${rule.set} WHERE id = ?`, [...(rule.reason ? [reason] : []), id]);
    const [after] = await conn.query<RowDataPacket[]>("SELECT * FROM merchants WHERE id = ?", [id]);
    await recordAudit(conn, {
      adminId,
      action: rule.action,
      targetType: "merchant",
      targetId: id,
      reason,
      before: pick(found[0]),
      after: pick(after[0]),
    });
  });
  return getMerchantDetail(id);
}
