import db from "../config/db";
import { MenuItem, MenuItemRow } from "../types";
import { ResultSetHeader } from "mysql2/promise";

let tableChecked = false;

export const initMenuTable = async (): Promise<void> => {
  if (tableChecked) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS menus (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        name VARCHAR(255) NOT NULL,
        cat ENUM('Nasi Box', 'Snack', 'Minuman', 'Paket Custom') NOT NULL,
        \`desc\` TEXT,
        img VARCHAR(255) DEFAULT '/menu/1.png',
        hpp INT NOT NULL,
        price INT NOT NULL,
        stock INT NOT NULL DEFAULT 0,
        hold INT NOT NULL DEFAULT 0,
        sold INT NOT NULL DEFAULT 0,
        est VARCHAR(50) DEFAULT '15 Mnt',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    tableChecked = true;
  } catch (err) {
    console.warn("Peringatan inisialisasi tabel menus:", err);
  }
};

export const getAllMenus = async (): Promise<MenuItemRow[]> => {
  await initMenuTable();
  const [rows] = await db.query<MenuItemRow[]>(
    "SELECT id, user_id, name, cat, `desc`, img, hpp, price, stock, hold, sold, est, is_active FROM menus WHERE is_active = TRUE ORDER BY id DESC"
  );
  return rows;
};

export const getMenuById = async (id: number): Promise<MenuItemRow | null> => {
  await initMenuTable();
  const [rows] = await db.query<MenuItemRow[]>(
    "SELECT id, user_id, name, cat, `desc`, img, hpp, price, stock, hold, sold, est, is_active FROM menus WHERE id = ?",
    [id]
  );
  return rows[0] || null;
};

export const createMenu = async (item: MenuItem): Promise<number> => {
  await initMenuTable();
  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO menus (user_id, name, cat, \`desc\`, img, hpp, price, stock, hold, sold, est)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.user_id || null,
      item.name,
      item.cat,
      item.desc || "",
      item.img || "/menu/1.png",
      item.hpp,
      item.price,
      item.stock || 0,
      item.hold || 0,
      item.sold || 0,
      item.est || "15 Mnt",
    ]
  );
  return result.insertId;
};

export const updateMenu = async (id: number, item: Partial<MenuItem>): Promise<boolean> => {
  await initMenuTable();
  const [result] = await db.query<ResultSetHeader>(
    `UPDATE menus SET 
      name = COALESCE(?, name),
      cat = COALESCE(?, cat),
      \`desc\` = COALESCE(?, \`desc\`),
      img = COALESCE(?, img),
      hpp = COALESCE(?, hpp),
      price = COALESCE(?, price),
      stock = COALESCE(?, stock),
      est = COALESCE(?, est)
     WHERE id = ?`,
    [
      item.name ?? null,
      item.cat ?? null,
      item.desc ?? null,
      item.img ?? null,
      item.hpp ?? null,
      item.price ?? null,
      item.stock ?? null,
      item.est ?? null,
      id,
    ]
  );
  return result.affectedRows > 0;
};

export const deleteMenu = async (id: number): Promise<boolean> => {
  await initMenuTable();
  const [result] = await db.query<ResultSetHeader>("DELETE FROM menus WHERE id = ?", [id]);
  return result.affectedRows > 0;
};
