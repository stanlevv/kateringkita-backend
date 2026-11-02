import { Request, RequestHandler, Router } from "express";
import { daftarLog, filterLog } from "./audit";
import { AuthedRequest } from "../auth/middleware";
import { AppError } from "../http/errors";
import { validate } from "../http/validate";
import { buatMaster, daftarMaster, setAktif, ubahMaster } from "./master";
import { ACTION_NAMES, antrianVerifikasi, daftarPenjual, detailPenjual, jalankanAksi } from "./merchants";
import { ambilBiaya, buatPromo, daftarPromo, setAktifPromo, ubahBiaya, ubahPromo } from "./promos";
import { reasonBody } from "./schemas";
import { ringkasan } from "./summary";

// Penjaga (requireAuth + requireRole("admin")) dipasang sekali di app.ts.
export const admin = Router();

const angka = (v: unknown, def: number, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
};
const idParam = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new AppError(404, "NOT_FOUND", "Penjual tidak ditemukan.");
  return n;
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const adminId = (req: unknown) => (req as AuthedRequest).auth.userId;
// POST <path>/activate dan <path>/deactivate
const toggle = (path: string, fn: (req: Request, aktif: boolean) => Promise<unknown>) => {
  for (const [aksi, aktif] of [["activate", true], ["deactivate", false]] as const) {
    admin.post(`${path}/${aksi}`, async (req, res) => {
      res.json({ data: await fn(req, aktif) });
    });
  }
};

admin.get("/audit-logs", async (req, res) => {
  res.json(await daftarLog(filterLog(req.query, angka(req.query.page, 1, 1e6), angka(req.query.limit, 20, 100))));
});

admin.get("/merchants", async (req, res) => {
  const { q, status, open } = req.query;
  res.json(await daftarPenjual({
    q: str(q)?.trim(), status: str(status), open: str(open),
    page: angka(req.query.page, 1, 1e6), limit: angka(req.query.limit, 20, 100),
  }));
});

admin.get("/verification-queue", async (_req, res) => {
  res.json({ data: await antrianVerifikasi() });
});

admin.get("/merchants/:id", async (req, res) => {
  res.json({ data: await detailPenjual(idParam(req.params.id)) });
});

// id dicek sebelum body: id tak valid → 404 walau body kosong
const cekId: RequestHandler = (req, _res, next) => {
  idParam(req.params.id);
  next();
};
for (const name of ACTION_NAMES) {
  const needsReason = name === "request-fix" || name === "suspend";
  admin.post(`/merchants/:id/${name}`, cekId, ...(needsReason ? [validate(reasonBody)] : []), async (req, res) => {
    res.json({ data: await jalankanAksi(adminId(req), idParam(req.params.id), name, req.body?.reason) });
  });
}

admin.get("/master/:kind", async (req, res) => {
  res.json({ data: await daftarMaster(req.params.kind) });
});
admin.post("/master/:kind", async (req, res) => {
  res.status(201).json({ data: await buatMaster(adminId(req), req.params.kind, req.body) });
});
admin.patch("/master/:kind/:id", async (req, res) => {
  res.json({ data: await ubahMaster(adminId(req), req.params.kind, req.params.id, req.body) });
});
toggle("/master/:kind/:id", (req, aktif) => setAktif(adminId(req), String(req.params.kind), req.params.id, aktif));

admin.get("/promos", async (_req, res) => {
  res.json({ data: await daftarPromo() });
});
admin.post("/promos", async (req, res) => {
  res.status(201).json({ data: await buatPromo(adminId(req), req.body) });
});
admin.patch("/promos/:id", async (req, res) => {
  res.json({ data: await ubahPromo(adminId(req), req.params.id, req.body) });
});
toggle("/promos/:id", (req, aktif) => setAktifPromo(adminId(req), req.params.id, aktif));
admin.get("/settings", async (_req, res) => {
  res.json({ data: { service_fee: await ambilBiaya() } });
});
admin.put("/settings/service-fee", async (req, res) => {
  res.json({ data: await ubahBiaya(adminId(req), req.body) });
});
admin.get("/summary", async (_req, res) => {
  res.json({ data: await ringkasan() });
});

// path admin tak dikenal berhenti di sini (404), tidak jatuh ke router v1
admin.use(() => {
  throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
});
