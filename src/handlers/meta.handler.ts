import { RequestHandler } from "express";
import { ambilPengaturan, daftarJenisUsaha, daftarKategori, daftarTitikTemu } from "../services/meta.service";

export const daftarJenisUsahaHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarJenisUsaha() });
};

export const daftarKategoriHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarKategori() });
};

export const daftarTitikTemuHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await daftarTitikTemu() });
};

export const pengaturanHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await ambilPengaturan() });
};
