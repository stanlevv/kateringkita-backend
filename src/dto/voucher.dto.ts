import { z } from "zod";

// GET /me/vouchers: tanpa filter = layar Voucher Saya; dengan filter = pemilih voucher di checkout
const kosong = (v: unknown) => (v === "" ? undefined : v);
export const voucherSayaSchema = z.object({
  merchant_id: z.preprocess(kosong, z.coerce.number({ error: "Toko tidak valid." }).int("Toko tidak valid.").min(1, "Toko tidak valid.").optional()),
  subtotal: z.preprocess(kosong, z.coerce.number({ error: "Subtotal tidak valid." }).int("Subtotal tidak valid.").min(0, "Subtotal tidak valid.").optional()),
  payment_method: z.preprocess(kosong, z.enum(["cod", "va", "online"], { error: "Metode bayar tidak dikenal." }).optional()),
});
export type VoucherSayaQuery = z.infer<typeof voucherSayaSchema>;
