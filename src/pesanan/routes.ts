import { Request, Router } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../auth/middleware";
import { parse, validate } from "../http/validate";
import { alasanSchema, bodyObjek, daftarSayaSchema, kunciSchema, pesananSchema, quoteSchema } from "./schemas";
import { bacaPesanan, batalkan, buatPesanan, daftarPesananSaya, quote, selesaikan, waPesanan } from "./service";

// Pesanan pembeli (F06); dipasang di /api/v1 sebelum v1
export const pesanan = Router();
const pembeli = [requireAuth, requireRole("customer")];
const uid = (req: Request) => (req as AuthedRequest).auth.userId;

pesanan.post("/orders/quote", ...pembeli, validate(quoteSchema), async (req, res) => {
  res.json({ data: await quote(req.body) });
});

pesanan.post("/orders", ...pembeli, async (req, res) => {
  const data = parse(pesananSchema, req.body);
  const kunci = parse(kunciSchema, req.get("Idempotency-Key"), "idempotency_key");
  res.status(201).json({ data: await buatPesanan(uid(req), kunci, data) });
});

pesanan.get("/orders/:code", ...pembeli, async (req, res) => {
  res.json({ data: await bacaPesanan(uid(req), String(req.params.code)) });
});

pesanan.get("/orders/:code/whatsapp", ...pembeli, async (req, res) => {
  res.json({ data: await waPesanan(uid(req), String(req.params.code)) });
});

// F07 (C-14): daftar 3 tab
pesanan.get("/me/orders", ...pembeli, async (req, res) => {
  res.json(await daftarPesananSaya(uid(req), parse(daftarSayaSchema, req.query)));
});

// F07 (C-15): batal, alasan opsional
pesanan.post("/orders/:code/cancel", ...pembeli, async (req, res) => {
  const { reason } = parse(alasanSchema, bodyObjek(req.body));
  res.json({ data: await batalkan(uid(req), String(req.params.code), reason) });
});

// F07 (C-16): pembeli menyelesaikan pesanan siap ambil
pesanan.post("/orders/:code/complete", ...pembeli, async (req, res) => {
  res.json({ data: await selesaikan(uid(req), String(req.params.code)) });
});
