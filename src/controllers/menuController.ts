import { Request, Response } from "express";
import * as menuModel from "../models/menuModel";
import { AuthRequest } from "../middlewares/authMiddleware";

export const getMenus = async (req: Request, res: Response): Promise<void> => {
  try {
    const menus = await menuModel.getAllMenus();
    res.json({ success: true, data: menus });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Gagal mengambil daftar menu", error: err.message });
  }
};

export const getMenu = async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ success: false, message: "ID menu tidak valid" });
    return;
  }

  try {
    const item = await menuModel.getMenuById(id);
    if (!item) {
      res.status(404).json({ success: false, message: "Menu tidak ditemukan" });
      return;
    }
    res.json({ success: true, data: item });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Gagal mengambil detail menu", error: err.message });
  }
};

export const createMenu = async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, cat, desc, img, hpp, price, stock, est } = req.body;

  if (!name || !cat || hpp === undefined || price === undefined) {
    res.status(400).json({
      success: false,
      message: "Nama menu, kategori, modal HPP, dan harga jual wajib diisi!",
    });
    return;
  }

  try {
    const userId = req.user?.userId || null;
    const insertId = await menuModel.createMenu({
      user_id: userId,
      name,
      cat,
      desc: desc || "",
      img: img || "/menu/1.png",
      hpp: Number(hpp),
      price: Number(price),
      stock: Number(stock) || 0,
      est: est || "15 Mnt",
    });

    const createdItem = await menuModel.getMenuById(insertId);
    res.status(201).json({
      success: true,
      message: "Menu berhasil disimpan ke database MySQL!",
      data: createdItem,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Gagal menyimpan menu ke database", error: err.message });
  }
};

export const updateMenu = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ success: false, message: "ID menu tidak valid" });
    return;
  }

  try {
    const updated = await menuModel.updateMenu(id, req.body);
    if (!updated) {
      res.status(404).json({ success: false, message: "Menu tidak ditemukan atau tidak ada perubahan" });
      return;
    }
    const item = await menuModel.getMenuById(id);
    res.json({ success: true, message: "Menu berhasil diperbarui", data: item });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Gagal memperbarui menu", error: err.message });
  }
};

export const deleteMenu = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ success: false, message: "ID menu tidak valid" });
    return;
  }

  try {
    const deleted = await menuModel.deleteMenu(id);
    if (!deleted) {
      res.status(404).json({ success: false, message: "Menu tidak ditemukan" });
      return;
    }
    res.json({ success: true, message: "Menu berhasil dihapus dari database" });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Gagal menghapus menu", error: err.message });
  }
};
