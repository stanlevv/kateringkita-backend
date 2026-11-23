import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { PopupInput, UbahPopup, popupSchema, ubahPopupSchema } from "../dto/popup.dto";
import { AppError } from "../utils/errors";
import { catat, dalamTransaksi, kunci } from "./admin-audit.service";
import { rapikan } from "./banner.service";
import { jam } from "./catalog.service";
import { VoucherKartu, voucherTersedia } from "./voucher.service";

// Pop-up promo saat aplikasi mobile dibuka (rancangan voucher 2026-11-16 §5.5). Hanya admin. Yang tayang = aktif terbaru
// dalam periode yang vouchernya (bila ada) masih tersedia. Frekuensi tampil (sekali sehari, berhenti setelah diklaim) di aplikasi.
const PREFIX = "platform/popup/";

const KOLOM =
  "q.id, q.title, q.image_url, q.promo_id, q.starts_at, q.ends_at, q.is_active, q.created_at, p.code AS promo_code";
const DARI = "popups q LEFT JOIN promos p ON p.id = q.promo_id";

const peta = (r: RowDataPacket) => ({
  id: r.id as number,
  title: r.title as string,
  image_url: r.image_url as string,
  promo: r.promo_id ? { id: r.promo_id as number, code: r.promo_code as string } : null,
  starts_at: r.starts_at,
  ends_at: r.ends_at,
  is_active: Boolean(r.is_active),
  created_at: r.created_at,
});
const baris = async (id: number) =>
  peta((await db.query<RowDataPacket[]>(`SELECT ${KOLOM} FROM ${DARI} WHERE q.id = ?`, [id]))[0][0]);

export type PopupPublik = { id: number; title: string; image_url: string; promo: VoucherKartu | null };

export async function popupPublik(userId: number | null): Promise<PopupPublik | null> {
  const ms = jam.sekarang();
  const now = new Date(ms);
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, title, image_url, promo_id FROM popups WHERE is_active AND starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 5",
    [now, now],
  );
  for (const r of rows) {
    const promo = r.promo_id ? await voucherTersedia(r.promo_id, userId, ms) : null;
    if (r.promo_id && !promo) continue; // voucher mati / habis periode → pop-up berikutnya
    return { id: r.id, title: r.title, image_url: r.image_url, promo };
  }
  return null;
}

async function cekVoucherPlatform(promoId: number | null | undefined) {
  if (!promoId) return null;
  const [[p]] = await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ? AND merchant_id IS NULL", [
    promoId,
  ]);
  if (!p) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { promo_id: ["Pilih voucher platform."] });
  return promoId;
}

export async function daftarPopup() {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM} FROM ${DARI} ORDER BY q.id DESC LIMIT 50`);
  return rows.map(peta);
}

export async function buatPopup(adminId: number, body: unknown) {
  const d: PopupInput = rapikan(popupSchema, body, PREFIX);
  const promoId = await cekVoucherPlatform(d.promo_id);
  const id = await dalamTransaksi(async (conn) => {
    const [r] = await conn.query<ResultSetHeader>(
      "INSERT INTO popups (title, image_url, promo_id, starts_at, ends_at, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [d.title, d.image_url, promoId, new Date(d.starts_at), new Date(d.ends_at), d.is_active, adminId],
    );
    await catat(conn, {
      adminId,
      action: "popup.create",
      targetType: "popup",
      targetId: r.insertId,
      after: { title: d.title, promo_id: promoId },
    });
    return r.insertId;
  });
  return baris(id);
}

export async function ubahPopup(adminId: number, idRaw: unknown, body: unknown) {
  const d: UbahPopup = rapikan(ubahPopupSchema, body, PREFIX);
  const promoId = d.promo_id === undefined ? undefined : await cekVoucherPlatform(d.promo_id);
  const id = await dalamTransaksi(async (conn) => {
    const q = await kunci(conn, "popups", idRaw, { notFound: "Pop-up tidak ditemukan." });
    const ubah: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        title: d.title,
        image_url: d.image_url,
        promo_id: promoId,
        starts_at: d.starts_at && new Date(d.starts_at),
        ends_at: d.ends_at && new Date(d.ends_at),
        is_active: d.is_active,
      }).filter(([, v]) => v !== undefined),
    );
    const cols = Object.keys(ubah);
    if (cols.length) {
      await conn.query(`UPDATE popups SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [
        ...cols.map((c) => ubah[c]),
        q.id,
      ]);
      await catat(conn, {
        adminId,
        action: "popup.update",
        targetType: "popup",
        targetId: q.id,
        before: Object.fromEntries(cols.map((c) => [c, q[c]])),
        after: ubah,
      });
    }
    return q.id as number;
  });
  return baris(id);
}
