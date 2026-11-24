// Isi file: perubahan data penjual oleh admin: membuat penjual baru, mengubah profil toko dan akun pemilik,
// menonaktifkan akun, serta menambah/mengubah/menghapus menu toko. Aturan isinya tidak ditulis ulang: file ini
// memanggil layanan yang sama dengan yang dipakai penjual sendiri (auth.service, merchant.service,
// merchant-menu.service) atas nama pemilik toko, lalu mencatat perubahan di log audit dengan target toko.
// Alurnya routes/admin.ts → handlers/admin-merchant-edit.handler.ts → file ini → database.
import { RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { AdminAccountUpdateInput } from "../dto/admin-user.dto";
import { RegisterMerchantInput } from "../dto/auth.dto";
import { UpdateProfileInput } from "../dto/merchant.dto";
import { MenuInput, MenuQuery, menuSchema } from "../dto/merchant-menu.dto";
import { AppError } from "../utils/errors";
import { recordAudit } from "./admin-audit.service";
import { getMerchantDetail } from "./admin-merchant.service";
import { setAccountActive, updateAccountByAdmin } from "./admin-user.service";
import { registerMerchant } from "./auth.service";
import { createMenu, deleteMenu, getMenu, listMenus, updateMenu } from "./merchant-menu.service";
import { getProfile, updateProfile } from "./merchant.service";

/**
 * Mencari id akun pemilik sebuah toko. Layanan penjual bekerja dengan id pemilik, sedangkan panel admin memakai id
 * toko.
 * @param merchantId id toko
 * @returns id pemilik (users.id)
 * @throws 404 toko tidak ada
 */
export async function getOwnerId(merchantId: number): Promise<number> {
  const [[merchant]] = await db.query<RowDataPacket[]>("SELECT user_id FROM merchants WHERE id = ?", [merchantId]);
  if (!merchant) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  return merchant.user_id;
}

// Mencatat satu perubahan toko di log audit; target selalu toko supaya muncul di "log terbaru" detail penjual.
const recordMerchantAudit = (adminId: number, merchantId: number, action: string, before: unknown, after: unknown) =>
  recordAudit(db, { adminId, action, targetType: "merchant", targetId: merchantId, before, after });

/**
 * Membuat akun pemilik dan tokonya atas nama admin, dengan aturan yang sama seperti pendaftaran penjual. Toko mulai
 * berstatus `pending` (menunggu verifikasi).
 * @param adminId id admin pembuat
 * @param input   data pemilik dan toko yang sudah lolos registerMerchantSchema
 * @returns detail penjual baru, sama dengan `GET /admin/merchants/:id`
 * @throws 400 jenis usaha tidak dikenal; galat `ER_DUP_ENTRY` (dijawab 409) bila nomor atau email sudah terdaftar
 */
export async function createMerchantByAdmin(adminId: number, input: RegisterMerchantInput) {
  const { merchant } = await registerMerchant(input);
  await recordMerchantAudit(adminId, merchant.id, "merchant.create", null, {
    business_name: merchant.business_name,
    owner_phone: input.phone,
  });
  return getMerchantDetail(merchant.id);
}

/**
 * Mengubah profil toko (nama usaha, alamat, WA toko, jam buka, dan lainnya) dengan aturan yang sama seperti
 * Pengaturan penjual.
 * @param adminId    id admin yang mengubah
 * @param merchantId id toko
 * @param input      kolom profil yang sudah lolos updateProfileSchema
 * @returns detail penjual sesudah diubah
 * @throws 404 toko tidak ada; 400 dari aturan profil toko (lihat merchant.service updateProfile)
 */
export async function updateMerchantStoreByAdmin(adminId: number, merchantId: number, input: UpdateProfileInput) {
  const ownerId = await getOwnerId(merchantId);
  const before = await getProfile(ownerId);
  const after = await updateProfile(ownerId, input);
  // Hanya kolom yang dikirim yang dicatat, supaya log mudah dibaca.
  const pick = (profile: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(input).map((key) => [key, profile[key]]));
  await recordMerchantAudit(adminId, merchantId, "merchant.store.update", pick(before), pick(after));
  return getMerchantDetail(merchantId);
}

/**
 * Mengubah nama, nomor WA login, dan/atau email pemilik toko.
 * @param adminId    id admin yang mengubah
 * @param merchantId id toko
 * @param input      kolom akun yang sudah lolos adminAccountUpdateSchema
 * @returns detail penjual sesudah diubah
 * @throws lihat admin-user.service updateAccountByAdmin
 */
export async function updateMerchantOwnerByAdmin(adminId: number, merchantId: number, input: AdminAccountUpdateInput) {
  const ownerId = await getOwnerId(merchantId);
  await updateAccountByAdmin(adminId, ownerId, "merchant", input, { targetType: "merchant", targetId: merchantId });
  return getMerchantDetail(merchantId);
}

/**
 * Menonaktifkan atau mengaktifkan lagi akun pemilik toko. Toko nonaktif tidak tampil di katalog.
 * @param adminId    id admin yang mengubah
 * @param merchantId id toko
 * @param active     `true` aktifkan, `false` nonaktifkan
 * @returns detail penjual sesudah diubah
 * @throws 404 toko tidak ada; 409 akun sudah dalam keadaan itu
 */
export async function setMerchantAccountActive(adminId: number, merchantId: number, active: boolean) {
  const ownerId = await getOwnerId(merchantId);
  await setAccountActive(adminId, ownerId, "merchant", active, { targetType: "merchant", targetId: merchantId });
  return getMerchantDetail(merchantId);
}

/**
 * Daftar menu sebuah toko, sama dengan yang dilihat penjual di halaman Menu.
 * @param merchantId id toko
 * @param query      filter yang sudah lolos menuQuerySchema
 * @returns daftar menu
 * @throws 404 toko tidak ada
 */
export async function listMerchantMenus(merchantId: number, query: MenuQuery) {
  return listMenus(await getOwnerId(merchantId), query);
}

/**
 * Detail satu menu toko.
 * @param merchantId id toko
 * @param menuId     id menu dari URL
 * @returns menu
 * @throws 404 toko atau menu tidak ada
 */
export async function getMerchantMenu(merchantId: number, menuId: unknown) {
  return getMenu(await getOwnerId(merchantId), menuId);
}

/**
 * Menambah menu ke toko. Foto hanya bisa dipakai dari unggahan toko itu sendiri, jadi menu dari admin biasanya tanpa
 * foto sampai penjual mengunggahnya.
 * @param adminId    id admin pembuat
 * @param merchantId id toko
 * @param input      menu yang sudah lolos menuSchema
 * @returns menu baru
 * @throws 404 toko tidak ada; 400 dari aturan menu (lihat merchant-menu.service createMenu)
 */
export async function createMerchantMenu(adminId: number, merchantId: number, input: z.infer<typeof menuSchema>) {
  const menu = await createMenu(await getOwnerId(merchantId), input);
  await recordMerchantAudit(adminId, merchantId, "menu.create", null, { menu_id: menu.id, name: menu.name });
  return menu;
}

/**
 * Mengubah sebagian data menu toko.
 * @param adminId    id admin yang mengubah
 * @param merchantId id toko
 * @param menuId     id menu dari URL
 * @param input      kolom menu yang sudah lolos menuPatchSchema
 * @returns menu sesudah diubah
 * @throws 404 toko atau menu tidak ada; 400 dari aturan menu
 */
export async function updateMerchantMenu(adminId: number, merchantId: number, menuId: unknown, input: MenuInput) {
  const ownerId = await getOwnerId(merchantId);
  const before = await getMenu(ownerId, menuId);
  const after = await updateMenu(ownerId, menuId, input);
  const pick = (menu: Record<string, unknown>) => Object.fromEntries(Object.keys(input).map((key) => [key, menu[key]]));
  await recordMerchantAudit(
    adminId,
    merchantId,
    "menu.update",
    { menu_id: before.id, ...pick(before) },
    { menu_id: after.id, ...pick(after) },
  );
  return after;
}

/**
 * Menghapus menu toko secara lunak (sama dengan hapus oleh penjual: riwayat pesanan tetap utuh).
 * @param adminId    id admin yang menghapus
 * @param merchantId id toko
 * @param menuId     id menu dari URL
 * @returns tidak ada nilai
 * @throws 404 toko atau menu tidak ada
 */
export async function deleteMerchantMenu(adminId: number, merchantId: number, menuId: unknown) {
  const ownerId = await getOwnerId(merchantId);
  const menu = await getMenu(ownerId, menuId);
  await deleteMenu(ownerId, menuId);
  await recordMerchantAudit(adminId, merchantId, "menu.delete", { menu_id: menu.id, name: menu.name }, null);
}
