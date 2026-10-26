import { Router } from "express";
import { getMenus, getMenu, createMenu, updateMenu, deleteMenu } from "../controllers/menuController";
import { authenticateToken } from "../middlewares/authMiddleware";

const router = Router();

// Endpoint publik katalog
router.get("/", getMenus);
router.get("/:id", getMenu);

// Endpoint mutasi terproteksi otentikasi JWT
router.post("/", authenticateToken, createMenu);
router.put("/:id", authenticateToken, updateMenu);
router.delete("/:id", authenticateToken, deleteMenu);

export default router;
