import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env as config } from "../config/env";
import { insertUser } from "../services/auth.service";
import { password as passwordSchema } from "../dto/auth.dto";
import { catat, dalamTransaksi } from "../services/admin-audit.service";

type VerificationStatus = "pending" | "needs_fix" | "verified" | "suspended";
type DemoMerchant = {
  phone: string;
  owner: string;
  name: string;
  status: VerificationStatus;
  note?: string;
  reason?: string;
  points: number[];
  menus: { name: string; price: number; hpp: number }[];
};

// Menu demo tanpa foto (image_url NULL); variasi checklist lewat titik temu & jumlah menu.
const DEMO_MERCHANTS: DemoMerchant[] = [
  {
    phone: "081100000001",
    owner: "Sari Demo",
    name: "Dapur Sari (demo menunggu)",
    status: "pending",
    points: [1],
    menus: [{ name: "Nasi Box Ayam", price: 18000, hpp: 12000 }],
  },
  {
    phone: "081100000002",
    owner: "Budi Demo",
    name: "Kue Budi (demo perlu perbaikan)",
    status: "needs_fix",
    note: "Tambahkan foto menu dan titik temu.",
    points: [],
    menus: [],
  },
  {
    phone: "081100000003",
    owner: "Citra Demo",
    name: "Es Citra (demo terverifikasi)",
    status: "verified",
    points: [2, 3],
    menus: [
      { name: "Es Teh Lemon", price: 8000, hpp: 3000 },
      { name: "Kopi Susu", price: 12000, hpp: 6000 },
      { name: "Es Jeruk", price: 7000, hpp: 3000 },
    ],
  },
  {
    phone: "081100000004",
    owner: "Dedi Demo",
    name: "Prasmanan Dedi (demo ditangguhkan)",
    status: "suspended",
    reason: "Laporan makanan tidak sesuai pesanan.",
    points: [1, 2],
    menus: [{ name: "Paket Prasmanan 20 Orang", price: 450000, hpp: 300000 }],
  },
];

export function isLocalHost(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function createDemoMerchant(demo: DemoMerchant, password: string): Promise<boolean> {
  const [existing] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE phone = ?", [demo.phone]);
  if (existing.length) return false;
  await dalamTransaksi(async (conn) => {
    const user = await insertUser(conn, "merchant", { full_name: demo.owner, phone: demo.phone, password });
    const slug = `demo-${demo.phone.slice(-2)}`;
    const [merchantResult] = await conn.query<ResultSetHeader>(
      `INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number, verification_status,
         verification_note, verified_at, suspended_at, suspended_reason)
       VALUES (?, 1, ?, ?, 'Kampus Vokasi UB, Malang', ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        demo.name,
        slug,
        demo.phone,
        demo.status,
        demo.note ?? null,
        demo.status === "verified" ? new Date() : null,
        demo.status === "suspended" ? new Date() : null,
        demo.reason ?? null,
      ],
    );
    for (const pickupPointId of demo.points)
      await conn.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES (?, ?)", [
        merchantResult.insertId,
        pickupPointId,
      ]);
    for (const menu of demo.menus) {
      await conn.query(
        "INSERT INTO menus (merchant_id, category_id, name, image_url, price, hpp, daily_quota, quota_today) VALUES (?, 1, ?, NULL, ?, ?, 20, 20)",
        [merchantResult.insertId, menu.name, menu.price, menu.hpp],
      );
    }
  });
  return true;
}

// Log hanya bermakna bila ada admin; dilewati bila sudah pernah dibuat.
async function createDemoAuditLogs(): Promise<"ok" | "no-admin"> {
  const [admins] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!admins.length) return "no-admin";
  const [existingLogs] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM admin_audit_logs WHERE reason = 'Data demo'",
  );
  if (Number(existingLogs[0].n) > 0) return "ok";
  const [demoMerchants] = await db.query<RowDataPacket[]>(
    "SELECT m.id, m.verification_status AS s FROM merchants m JOIN users u ON u.id = m.user_id WHERE u.phone IN (?)",
    [DEMO_MERCHANTS.map((demo) => demo.phone)],
  );
  const actionByStatus: Record<string, string> = {
    needs_fix: "merchant.request_fix",
    verified: "merchant.verify",
    suspended: "merchant.suspend",
  };
  await dalamTransaksi(async (conn) => {
    for (const merchant of demoMerchants) {
      if (!actionByStatus[merchant.s]) continue;
      await catat(conn, {
        adminId: admins[0].id,
        action: actionByStatus[merchant.s],
        targetType: "merchant",
        targetId: merchant.id,
        reason: "Data demo",
        before: { verification_status: "pending" },
        after: { verification_status: merchant.s },
      });
    }
  });
  return "ok";
}

// Mengembalikan kode keluar proses. Sandi hanya dari env dan tidak pernah dicetak.
export async function run(env: NodeJS.ProcessEnv, args: string[] = []): Promise<number> {
  if (env.NODE_ENV === "production") {
    console.error("Data demo tidak boleh dibuat di lingkungan produksi.");
    return 1;
  }
  const url = env.DATABASE_URL ?? config.DATABASE_URL;
  // DB uji (nama berakhiran _test, mis. di TiDB) juga boleh: isinya memang dikosongkan setiap uji
  const isTestDatabase = (() => {
    try {
      return new URL(url).pathname.endsWith("_test");
    } catch {
      return false;
    }
  })();
  if (!isLocalHost(url) && !isTestDatabase && !args.includes("--paksa")) {
    console.error("Data demo hanya untuk database lokal. Tambahkan --paksa bila memang disengaja.");
    return 1;
  }
  const password = env.DEMO_PASSWORD;
  if (!password) {
    console.error("DEMO_PASSWORD belum diisi.");
    return 1;
  }
  const passwordCheck = passwordSchema.safeParse(password);
  if (!passwordCheck.success) {
    console.error(
      `DEMO_PASSWORD tidak memenuhi aturan: ${passwordCheck.error.issues.map((issue) => issue.message).join(" ")}`,
    );
    return 1;
  }
  try {
    let createdCount = 0;
    for (const demo of DEMO_MERCHANTS) if (await createDemoMerchant(demo, password)) createdCount++;
    console.log(`Penjual demo baru: ${createdCount} dari ${DEMO_MERCHANTS.length}.`);
    if ((await createDemoAuditLogs()) === "no-admin")
      console.log("Belum ada admin, log aktivitas dilewati. Jalankan npm run admin:create lalu seed:demo lagi.");
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (require.main === module) {
  run(process.env, process.argv.slice(2))
    .then((code) => db.end().then(() => process.exit(code)))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(1);
    });
}
