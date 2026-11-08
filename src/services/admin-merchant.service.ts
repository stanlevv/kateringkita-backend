import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { catat, daftarLog, dalamTransaksi } from "./admin-audit.service";

export const STATUSES = ["pending", "needs_fix", "verified", "suspended"] as const;
type Status = (typeof STATUSES)[number];

// Transisi K1. `set` = kolom yang berubah (nilai SQL), `cols` = kolom yang dicatat before/after.
type Rule = { action: string; from: Status[]; set: string; cols: string[]; reason?: "note" | "suspend" };
const RULES: Record<string, Rule> = {
  verify: {
    action: "merchant.verify", from: ["pending", "needs_fix"],
    set: "verification_status='verified', verified_at=UTC_TIMESTAMP(), verification_note=NULL",
    cols: ["verification_status", "verified_at", "verification_note"],
  },
  "request-fix": {
    action: "merchant.request_fix", from: ["pending"],
    set: "verification_status='needs_fix', verification_note=?",
    cols: ["verification_status", "verification_note"], reason: "note",
  },
  suspend: {
    action: "merchant.suspend", from: ["pending", "needs_fix", "verified"],
    set: "verification_status='suspended', verified_at=NULL, suspended_at=UTC_TIMESTAMP(), suspended_reason=?",
    cols: ["verification_status", "verified_at", "suspended_at", "suspended_reason"], reason: "suspend",
  },
  reactivate: {
    action: "merchant.reactivate", from: ["suspended"],
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
const checklist = (row: RowDataPacket) => Object.fromEntries(CHECK_KEYS.map((k) => [k, Boolean(row[`chk_${k}`])]));
const notChk = ([k]: [string, unknown]) => !k.startsWith("chk_");

const likeEscape = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export async function daftarPenjual(f: { q?: string; status?: string; open?: string; page: number; limit: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status !== undefined) {
    if (!STATUSES.includes(f.status as Status)) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { status: ["Status tidak dikenal."] });
    where.push("m.verification_status = ?");
    args.push(f.status);
  }
  if (f.open !== undefined) {
    if (f.open !== "0" && f.open !== "1") throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { open: ["Harus 1 atau 0."] });
    where.push("m.is_open = ?");
    args.push(Number(f.open));
  }
  if (f.q) {
    where.push("(LOWER(m.business_name) LIKE LOWER(?) OR m.wa_number LIKE ?)");
    const like = `%${likeEscape(f.q)}%`;
    args.push(like, like);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, u.full_name AS owner_name, m.wa_number, m.verification_status, m.is_open,
            (SELECT COUNT(*) FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS menu_count,
            m.created_at
     FROM merchants m JOIN users u ON u.id = m.user_id ${w}
     ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    [...args, f.limit, (f.page - 1) * f.limit],
  );
  const [c] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM merchants m ${w}`, args);
  return { data: rows.map((r) => ({ ...r, is_open: Boolean(r.is_open), menu_count: Number(r.menu_count) })), meta: { page: f.page, limit: f.limit, total: Number(c[0].total) } };
}

export async function antrianVerifikasi() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, u.full_name AS owner_name, m.wa_number, m.verification_status, m.verification_note, m.created_at,
            ${CHECKLIST_SQL},
            COALESCE(GREATEST(m.updated_at, COALESCE((SELECT MAX(x.updated_at) FROM menus x WHERE x.merchant_id = m.id), m.updated_at))
              > (SELECT MAX(l.created_at) FROM admin_audit_logs l WHERE l.target_type = 'merchant' AND l.target_id = m.id AND l.action = 'merchant.request_fix'), 0) AS updated_after_note
     FROM merchants m JOIN users u ON u.id = m.user_id
     WHERE m.verification_status IN ('pending','needs_fix')
     ORDER BY m.created_at ASC, m.id ASC`,
  );
  return rows.map((r) => {
    const { updated_after_note, ...rest } = r;
    const lean = Object.fromEntries(Object.entries(rest).filter(notChk));
    return { ...lean, checklist: checklist(r), updated_after_note: Boolean(updated_after_note) };
  });
}

export async function detailPenjual(id: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.*, u.full_name AS owner_full_name, u.phone AS owner_phone, u.email AS owner_email, u.is_active AS owner_is_active,
            t.name AS merchant_type_name,
            (SELECT COUNT(*) FROM menus x WHERE x.merchant_id = m.id AND x.is_active AND x.deleted_at IS NULL) AS menu_count,
            ${CHECKLIST_SQL}
     FROM merchants m JOIN users u ON u.id = m.user_id JOIN merchant_types t ON t.id = m.merchant_type_id WHERE m.id = ?`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  const r = rows[0];
  const [points] = await db.query<RowDataPacket[]>(
    "SELECT p.id, p.name FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id WHERE mp.merchant_id = ? ORDER BY p.name",
    [id],
  );
  const { data: logs } = await daftarLog({ page: 1, limit: 10, targetType: "merchant", targetId: String(id) });
  const profile = Object.fromEntries(
    Object.entries(r).filter((e) => notChk(e) && !e[0].startsWith("owner_")),
  );
  return {
    ...profile,
    is_open: Boolean(r.is_open),
    menu_count: Number(r.menu_count),
    owner: { full_name: r.owner_full_name, phone: r.owner_phone, email: r.owner_email, is_active: Boolean(r.owner_is_active) },
    pickup_points: points,
    checklist: checklist(r),
    recent_logs: logs,
  };
}

export async function jalankanAksi(adminId: number, id: number, name: string, reason?: string) {
  const rule = RULES[name];
  await dalamTransaksi(async (conn) => {
    const pick = (row: RowDataPacket) => Object.fromEntries(rule.cols.map((c) => [c, row[c]]));
    const [found] = await conn.query<RowDataPacket[]>("SELECT * FROM merchants WHERE id = ? FOR UPDATE", [id]);
    if (!found[0]) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
    if (!rule.from.includes(found[0].verification_status)) throw new AppError(409, "CONFLICT", "Status penjual sudah berubah.");
    if (name === "close-today" && !found[0].is_open) return; // sudah tutup: tanpa perubahan dan tanpa log
    if (!rule.reason) reason = undefined; // hanya aksi bertanda reason yang memakai alasan (sudah divalidasi)
    await conn.query(`UPDATE merchants SET ${rule.set} WHERE id = ?`, [...(rule.reason ? [reason] : []), id]);
    const [after] = await conn.query<RowDataPacket[]>("SELECT * FROM merchants WHERE id = ?", [id]);
    await catat(conn, { adminId, action: rule.action, targetType: "merchant", targetId: id, reason, before: pick(found[0]), after: pick(after[0]) });
  });
  return detailPenjual(id);
}
