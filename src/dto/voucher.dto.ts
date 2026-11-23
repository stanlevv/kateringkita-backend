import { z } from "zod";

// GET /me/vouchers: tanpa filter = layar Voucher Saya; dengan filter = pemilih voucher di checkout
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
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
export type MyVouchersQuery = z.infer<typeof myVouchersSchema>;
