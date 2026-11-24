// Isi file: skema zod untuk query `GET /me/vouchers` ("Voucher Saya"). zod = pustaka yang memeriksa bentuk data
// masuk; data yang tidak lolos dijawab 400 beserta pesan per kolom. Dipakai handlers/voucher.handler.ts sebelum
// memanggil voucher.service. Nama kunci di sini adalah kontrak JSON.
import { z } from "zod";

// Query kosong (`?subtotal=`) dianggap tidak dikirim.
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
/**
 * Query "Voucher Saya". Tanpa filter = layar Voucher Saya. Dengan filter = pemilih voucher di checkout: `merchant_id`
 * (toko keranjang), `subtotal` (jumlah belanja, bilangan bulat ≥ 0), dan `payment_method` (`cod`, `va`, `online`)
 * dipakai untuk menentukan voucher mana yang bisa dipakai di keranjang itu.
 */
export const myVouchersSchema = z.object({
  merchant_id: z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: "Toko tidak valid." }).int("Toko tidak valid.").min(1, "Toko tidak valid.").optional(),
  ),
  subtotal: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: "Subtotal tidak valid." })
      .int("Subtotal tidak valid.")
      .min(0, "Subtotal tidak valid.")
      .optional(),
  ),
  payment_method: z.preprocess(
    emptyToUndefined,
    z.enum(["cod", "va", "online"], { error: "Metode bayar tidak dikenal." }).optional(),
  ),
});
/** Query "Voucher Saya" yang sudah lolos {@link myVouchersSchema}. */
export type MyVouchersQuery = z.infer<typeof myVouchersSchema>;
