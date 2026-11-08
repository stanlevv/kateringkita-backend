import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { parse } from "../middleware/validate";
import { alasanSchema, bodyObjek } from "../dto/pesanan.dto";
import { transisi } from "./pesanan-status.service";
import { dasarPesanan, halaman, Item, KOLOM, muatItem, nilaiWa, pola, render, tautanWa } from "./pesanan.service";
import { idToko } from "./merchant-menu.service";
import { DaftarToko } from "../dto/merchant-order.dto";

// F07 pesanan toko (M-04, R-10, R-11). Toko selalu dari token; pesanan toko lain = 404 (D9).
const DARI_TOKO = `${KOLOM}, o.customer_name, o.customer_phone,
  o.confirmed_at, o.cooking_at, o.ready_at, o.completed_at, o.cancelled_at
  FROM orders o JOIN pickup_points p ON p.id = o.pickup_point_id`;

// MerchantOrder §7 (D13): Order tanpa merchant/can_*, plus data pembeli & jejak waktu
export const petaPesananToko = (o: RowDataPacket, items: Item[]) => ({
  ...dasarPesanan(o, items),
  customer_name: o.customer_name, customer_phone: o.customer_phone,
  confirmed_at: o.confirmed_at, cooking_at: o.cooking_at, ready_at: o.ready_at, completed_at: o.completed_at, cancelled_at: o.cancelled_at,
});

// D11, D12: updated_since mengabaikan status; date = tanggal WIB created_at → rentang UTC agar indeks terpakai
export async function daftarPesananToko(userId: number, f: DaftarToko) {
  const where = ["o.merchant_id = ?"];
  const args: unknown[] = [await idToko(userId)];
  if (f.updated_since) {
    where.push("o.updated_at >= ?");
    args.push(new Date(f.updated_since));
  } else if (f.status.length) {
    where.push("o.status IN (?)");
    args.push(f.status);
  }
  if (f.date) {
    const awal = Date.parse(`${f.date}T00:00:00+07:00`);
    where.push("o.created_at >= ? AND o.created_at < ?");
    args.push(new Date(awal), new Date(awal + 86400e3));
  }
  if (f.q) {
    where.push("(LOWER(o.code) LIKE LOWER(?) OR LOWER(o.customer_name) LIKE LOWER(?))");
    args.push(pola(f.q), pola(f.q));
  }
  return halaman(DARI_TOKO, where, args, f, petaPesananToko);
}

export async function ambilPesananToko(userId: number, code: string) {
  const [[o]] = await db.query<RowDataPacket[]>(`SELECT ${DARI_TOKO} WHERE o.code = ? AND o.merchant_id = ?`, [code, await idToko(userId)]);
  if (!o) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  return petaPesananToko(o, (await muatItem([o.id])).get(o.id) ?? []);
}

export const AKSI_TOKO = ["confirm", "pay", "cook", "ready", "complete", "reject"] as const;
export type AksiToko = (typeof AKSI_TOKO)[number];

// M-04, M-08 (D1, D8): transisi dengan aktor penjual lalu bentuk terkini; tolak wajib beralasan
export async function aksiPesananToko(userId: number, code: string, aksi: AksiToko, body: unknown) {
  // body hanya bermakna untuk tolak; aksi lain mengabaikannya
  const reason = aksi === "reject" ? parse(alasanSchema, bodyObjek(body)).reason : null;
  if (aksi === "reject" && !reason) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { reason: ["Pilih alasan penolakan."] });
  }
  const merchantId = await idToko(userId);
  await dalamTransaksi((c) => transisi(c, code, aksi, { jenis: "merchant", userId, merchantId }, reason));
  return ambilPesananToko(userId, code);
}

// D17: salinan persis fe/lib/wa-template.ts#TEMPLATE_BAWAAN (dijaga test merchant-orders-wa)
export const TEMPLAT_BAWAAN = `Halo {nama}, pesanan {kode} sudah kami terima.

Menu: {menu}
Total: {total}
Cara bayar: {metode_bayar}
Ambil di: {titik_temu}
Waktu ambil: {waktu_ambil}

Terima kasih sudah memesan.`;

// M-04, M-11 (D17): chat penjual → pembeli memakai templat toko
export async function waPesananToko(userId: number, code: string) {
  const [[o]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.code, o.customer_name, o.customer_phone, o.total, o.pickup_at, o.payment_method, o.note, m.business_name, m.wa_template,
       p.name AS titik_temu
     FROM orders o JOIN merchants m ON m.id = o.merchant_id JOIN pickup_points p ON p.id = o.pickup_point_id
     WHERE o.code = ? AND o.merchant_id = ?`,
    [code, await idToko(userId)],
  );
  if (!o) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  const items = (await muatItem([o.id])).get(o.id) ?? [];
  const message = render(o.wa_template ?? TEMPLAT_BAWAAN, nilaiWa({ ...(o as Parameters<typeof nilaiWa>[0]), items }));
  return { wa_number: o.customer_phone, message, url: tautanWa(o.customer_phone, message) };
}
