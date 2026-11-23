// Isi file: profil toko milik penjual yang login: baca profil, buka/tutup dapur, dan ubah profil (termasuk logo,
// sampul, jam buka, dan titik temu). Alurnya routes/merchant.ts → handlers/merchant.handler.ts → file ini → database.
// Toko selalu dicari dari id pengguna di token login, tidak pernah dari isi request, jadi penjual hanya bisa
// mengubah tokonya sendiri.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { validateImageUrl } from "./upload.service";
import { UpdateProfileInput } from "../dto/merchant.dto";

/**
 * Membaca profil toko milik penjual yang login.
 * @param userId id pengguna penjual dari token login
 * @returns profil toko: nama, deskripsi, alamat, nomor WA, logo, sampul, jenis usaha, mode layanan, status dapur,
 *          jam buka/tutup (`JJ:MM`), lama tahan pesanan, target omzet, templat WA, id titik temu yang masih aktif,
 *          dan pilihan terima pesanan dari meja (QR)
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function getProfile(userId: number) {
  // 1. Ambil data toko beserta nama jenis usahanya. Jam diubah ke teks `JJ:MM`.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, m.description, m.address, m.wa_number, m.logo_url, m.cover_url, m.service_mode, m.is_open,
            TIME_FORMAT(m.open_time, '%H:%i') AS open_time, TIME_FORMAT(m.close_time, '%H:%i') AS close_time,
            m.hold_minutes, m.daily_revenue_target, m.wa_template, m.dine_in_enabled, t.id AS type_id, t.name AS type_name
     FROM merchants m JOIN merchant_types t ON t.id = m.merchant_type_id WHERE m.user_id = ?`,
    [userId],
  );
  const merchant = rows[0];
  if (!merchant) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  // 2. Ambil titik temu toko yang masih aktif (titik temu yang dinonaktifkan admin tidak ikut).
  const [pickupPoints] = await db.query<RowDataPacket[]>(
    `SELECT mp.pickup_point_id AS id FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id
     WHERE mp.merchant_id = ? AND p.is_active ORDER BY mp.pickup_point_id`,
    [merchant.id],
  );
  // 3. Susun respons. Nilai 0/1 dari database diubah ke true/false.
  return {
    business_name: merchant.business_name,
    description: merchant.description,
    address: merchant.address,
    wa_number: merchant.wa_number,
    logo_url: merchant.logo_url,
    cover_url: merchant.cover_url,
    merchant_type: { id: merchant.type_id, name: merchant.type_name },
    service_mode: merchant.service_mode,
    is_open: Boolean(merchant.is_open),
    open_time: merchant.open_time,
    close_time: merchant.close_time,
    hold_minutes: merchant.hold_minutes,
    daily_revenue_target: merchant.daily_revenue_target,
    wa_template: merchant.wa_template,
    pickup_point_ids: pickupPoints.map((point) => point.id as number),
    // pilihan menerima pesanan dari meja lewat kode QR
    dine_in_enabled: Boolean(merchant.dine_in_enabled),
  };
}

/**
 * Membuka atau menutup dapur toko secara manual (saklar "terima pesanan" milik penjual). Waktu terakhir diubah
 * (`updated_at`) sengaja tidak digeser, karena buka/tutup dapur bukan perubahan data profil.
 * @param userId id pengguna penjual dari token login
 * @param isOpen true untuk membuka dapur, false untuk menutup
 * @returns status dapur yang baru, `{ is_open }`
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function setOpen(userId: number, isOpen: boolean): Promise<{ is_open: boolean }> {
  const [result] = await db.query<any>("UPDATE merchants SET is_open = ?, updated_at = updated_at WHERE user_id = ?", [
    isOpen,
    userId,
  ]);
  if (result.affectedRows === 0) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  return { is_open: isOpen };
}

// Galat 400 dengan pesan per kolom, contoh `{ close_time: ["Jam tutup harus setelah jam buka."] }`.
const validationError = (fields: Record<string, string[]>) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
// Kolom profil yang boleh diubah penjual dan disalin apa adanya dari body.
const PROFILE_COLUMNS = [
  "business_name",
  "description",
  "address",
  "wa_number",
  "service_mode",
  "open_time",
  "close_time",
  "hold_minutes",
  "daily_revenue_target",
  "wa_template",
  "logo_url",
  "cover_url",
] as const;

/**
 * Mengubah sebagian profil toko. Hanya kolom yang dikirim yang diubah. Semua langkah berjalan dalam satu transaksi DB:
 * rangkaian perubahan yang disimpan semua atau dibatalkan semua, jadi profil dan titik temu tidak pernah setengah
 * tersimpan.
 * @param userId id pengguna penjual dari token login
 * @param input  body yang sudah lolos updateProfileSchema (semua kolom opsional)
 * @returns profil toko terbaru, sama dengan {@link getProfile}
 * @throws 400 bila tidak ada data yang diubah, URL logo/sampul bukan unggahan toko ini, jam tutup tidak setelah jam
 *         buka, atau ada titik temu yang tidak ada/tidak aktif; 404 bila pengguna ini tidak punya toko
 */
export async function updateProfile(userId: number, input: UpdateProfileInput) {
  // 1. Kumpulkan kolom yang dikirim. Deskripsi kosong disimpan sebagai null; pilihan pesan dari meja jadi 1/0.
  const columnValues: Record<string, string | number | null> = {};
  for (const column of PROFILE_COLUMNS) if (input[column] !== undefined) columnValues[column] = input[column];
  if (input.dine_in_enabled !== undefined) columnValues.dine_in_enabled = input.dine_in_enabled ? 1 : 0;
  if (columnValues.description === "") columnValues.description = null;
  // 2. Id titik temu: yang kembar dibuang lalu diurutkan dari kecil ke besar.
  const pickupPointIds =
    input.pickup_point_ids === undefined
      ? undefined
      : [...new Set(input.pickup_point_ids)].sort((first, second) => first - second);
  if (Object.keys(columnValues).length === 0 && !pickupPointIds)
    throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");

  await dalamTransaksi(async (conn) => {
    let pickupPointsChanged = false;
    // 3. Kunci baris toko (FOR UPDATE = baca sambil mengunci, transaksi lain menunggu). Urutan kunci selalu toko lalu
    //    titik temu, sama dengan pengecekan titik temu terakhir di admin-master.service, supaya tidak saling menunggu.
    const [merchantRows] = await conn.query<RowDataPacket[]>(
      "SELECT id, TIME_FORMAT(open_time, '%H:%i') AS o, TIME_FORMAT(close_time, '%H:%i') AS c, logo_url, cover_url FROM merchants WHERE user_id = ? FOR UPDATE",
      [userId],
    );
    const merchant = merchantRows[0];
    if (!merchant) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
    // 4. Logo dan sampul baru harus hasil unggahan ke folder toko ini; URL yang sama dengan yang tersimpan diterima.
    validateImageUrl(input.logo_url, merchant.logo_url, `merchants/${merchant.id}/logo/`, "logo_url");
    validateImageUrl(input.cover_url, merchant.cover_url, `merchants/${merchant.id}/cover/`, "cover_url");
    // 5. Jam tutup harus setelah jam buka. Jam yang tidak dikirim diambil dari nilai tersimpan (`o` = buka,
    //    `c` = tutup). Teks `JJ:MM` bisa dibandingkan langsung karena urutan hurufnya sama dengan urutan waktu.
    if (
      (input.open_time !== undefined || input.close_time !== undefined) &&
      (input.close_time ?? merchant.c) <= (input.open_time ?? merchant.o)
    ) {
      throw validationError({ close_time: ["Jam tutup harus setelah jam buka."] });
    }
    if (pickupPointIds) {
      // 6. Semua titik temu yang dipilih harus ada dan aktif. Dipakai FOR UPDATE, bukan FOR SHARE, karena TiDB
      //    (database production, mirip MySQL) menolak FOR SHARE.
      const [activePoints] = await conn.query<RowDataPacket[]>(
        "SELECT id FROM pickup_points WHERE id IN (?) AND is_active FOR UPDATE",
        [pickupPointIds],
      );
      if (activePoints.length !== pickupPointIds.length)
        throw validationError({ pickup_point_ids: ["Titik temu tidak tersedia."] });
      // 7. Bandingkan dengan titik temu tersimpan, lalu hapus yang dilepas dan sisipkan yang baru. Hanya selisihnya
      //    yang ditulis: menghapus lalu menyisipkan ulang semuanya bisa membuat dua penjual saling mengunci (deadlock).
      const [savedPoints] = await conn.query<RowDataPacket[]>(
        "SELECT pickup_point_id AS id FROM merchant_pickup_points WHERE merchant_id = ? ORDER BY 1",
        [merchant.id],
      );
      const savedIds = new Set<number>(savedPoints.map((point) => point.id));
      const removedIds = [...savedIds].filter((id) => !pickupPointIds.includes(id));
      const addedIds = pickupPointIds.filter((id) => !savedIds.has(id));
      pickupPointsChanged = removedIds.length > 0 || addedIds.length > 0;
      if (removedIds.length)
        await conn.query("DELETE FROM merchant_pickup_points WHERE merchant_id = ? AND pickup_point_id IN (?)", [
          merchant.id,
          removedIds,
        ]);
      if (addedIds.length)
        await conn.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES ?", [
          addedIds.map((id) => [merchant.id, id]),
        ]);
    }
    // 8. Simpan kolom profil. `updated_at` bergeser sendiri bila ada kolom yang berubah; bila yang berubah hanya titik
    //    temu, `updated_at` digeser dengan tangan supaya perubahan itu tetap tercatat.
    const columns = Object.keys(columnValues);
    const assignments = [
      ...columns.map((column) => `${column} = ?`),
      ...(pickupPointsChanged ? ["updated_at = CURRENT_TIMESTAMP"] : []),
    ];
    if (assignments.length > 0)
      await conn.query(`UPDATE merchants SET ${assignments.join(", ")} WHERE id = ?`, [
        ...columns.map((column) => columnValues[column]),
        merchant.id,
      ]);
  });
  // 9. Kirim profil terbaru.
  return getProfile(userId);
}
