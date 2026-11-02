import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env as config } from "../config/env";
import { insertUser } from "../auth/service";
import { password as passwordSchema } from "../auth/schemas";
import { catat, dalamTransaksi } from "../admin/audit";

type Status = "pending" | "needs_fix" | "verified" | "suspended";
type Demo = {
  phone: string; owner: string; name: string; status: Status; note?: string; reason?: string;
  points: number[]; menus: { name: string; price: number; hpp: number }[];
};

// Menu demo tanpa foto (image_url NULL); variasi checklist lewat titik temu & jumlah menu.
const DEMO: Demo[] = [
  { phone: "081100000001", owner: "Sari Demo", name: "Dapur Sari (demo menunggu)", status: "pending",
    points: [1], menus: [{ name: "Nasi Box Ayam", price: 18000, hpp: 12000 }] },
  { phone: "081100000002", owner: "Budi Demo", name: "Kue Budi (demo perlu perbaikan)", status: "needs_fix",
    note: "Tambahkan foto menu dan titik temu.", points: [], menus: [] },
  { phone: "081100000003", owner: "Citra Demo", name: "Es Citra (demo terverifikasi)", status: "verified",
    points: [2, 3], menus: [
      { name: "Es Teh Lemon", price: 8000, hpp: 3000 },
      { name: "Kopi Susu", price: 12000, hpp: 6000 },
      { name: "Es Jeruk", price: 7000, hpp: 3000 },
    ] },
  { phone: "081100000004", owner: "Dedi Demo", name: "Prasmanan Dedi (demo ditangguhkan)", status: "suspended",
    reason: "Laporan makanan tidak sesuai pesanan.", points: [1, 2],
    menus: [{ name: "Paket Prasmanan 20 Orang", price: 450000, hpp: 300000 }] },
];

export function hostLokal(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function buat(d: Demo, password: string): Promise<boolean> {
  const [ada] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE phone = ?", [d.phone]);
  if (ada.length) return false;
  await dalamTransaksi(async (conn) => {
    const u = await insertUser(conn, "merchant", { full_name: d.owner, phone: d.phone, password });
    const slug = `demo-${d.phone.slice(-2)}`;
    const [m] = await conn.query<ResultSetHeader>(
      `INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number, verification_status,
         verification_note, verified_at, suspended_at, suspended_reason)
       VALUES (?, 1, ?, ?, 'Kampus Vokasi UB, Malang', ?, ?, ?, ?, ?, ?)`,
      [u.id, d.name, slug, d.phone, d.status, d.note ?? null,
        d.status === "verified" ? new Date() : null, d.status === "suspended" ? new Date() : null, d.reason ?? null],
    );
    for (const p of d.points) await conn.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, ?)", [m.insertId, p]);
    for (const x of d.menus) {
      await conn.query(
        "INSERT INTO menus (merchant_id, category_id, name, image_url, price, hpp, daily_quota, quota_today) VALUES (?, 1, ?, NULL, ?, ?, 20, 20)",
        [m.insertId, x.name, x.price, x.hpp],
      );
    }
  });
  return true;
}

// Log hanya bermakna bila ada admin; dilewati bila sudah pernah dibuat.
async function buatLog(): Promise<"ok" | "tanpa-admin"> {
  const [admins] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!admins.length) return "tanpa-admin";
  const [sudah] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE reason = 'Data demo'");
  if (Number(sudah[0].n) > 0) return "ok";
  const [ms] = await db.query<RowDataPacket[]>(
    "SELECT m.id, m.verification_status AS s FROM merchants m JOIN users u ON u.id = m.user_id WHERE u.phone IN (?)",
    [DEMO.map((d) => d.phone)],
  );
  const aksi: Record<string, string> = { needs_fix: "merchant.request_fix", verified: "merchant.verify", suspended: "merchant.suspend" };
  await dalamTransaksi(async (conn) => {
    for (const m of ms) {
      if (!aksi[m.s]) continue;
      await catat(conn, {
        adminId: admins[0].id, action: aksi[m.s], targetType: "merchant", targetId: m.id,
        reason: "Data demo", before: { verification_status: "pending" }, after: { verification_status: m.s },
      });
    }
  });
  return "ok";
}

// Mengembalikan kode keluar proses. Sandi hanya dari env dan tidak pernah dicetak.
export async function jalankan(env: NodeJS.ProcessEnv, args: string[] = []): Promise<number> {
  if (env.NODE_ENV === "production") {
    console.error("Data demo tidak boleh dibuat di lingkungan produksi.");
    return 1;
  }
  if (!hostLokal(env.DATABASE_URL ?? config.DATABASE_URL) && !args.includes("--paksa")) {
    console.error("Data demo hanya untuk database lokal. Tambahkan --paksa bila memang disengaja.");
    return 1;
  }
  const password = env.DEMO_PASSWORD;
  if (!password) {
    console.error("DEMO_PASSWORD belum diisi.");
    return 1;
  }
  const cek = passwordSchema.safeParse(password);
  if (!cek.success) {
    console.error(`DEMO_PASSWORD tidak memenuhi aturan: ${cek.error.issues.map((i) => i.message).join(" ")}`);
    return 1;
  }
  try {
    let baru = 0;
    for (const d of DEMO) if (await buat(d, password)) baru++;
    console.log(`Penjual demo baru: ${baru} dari ${DEMO.length}.`);
    if ((await buatLog()) === "tanpa-admin") console.log("Belum ada admin, log aktivitas dilewati. Jalankan npm run admin:create lalu seed:demo lagi.");
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (require.main === module) {
  jalankan(process.env, process.argv.slice(2))
    .then((code) => db.end().then(() => process.exit(code)))
    .catch((err) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
