// Isi file: skrip pengisi data demo untuk database lokal (`npm run seed:demo`): empat penjual contoh dengan status
// verifikasi berbeda (menunggu, perlu perbaikan, terverifikasi, ditangguhkan) beserta titik temu, menu, dan log
// aktivitas admin, supaya panel admin bisa dicoba tanpa mengisi data satu per satu. Sandi semua akun demo diambil dari
// DEMO_PASSWORD.
import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { env as config } from "../config/env";
import { insertUser } from "../services/auth.service";
import { passwordSchema } from "../dto/auth.dto";
import { catat, dalamTransaksi } from "../services/admin-audit.service";

// Status verifikasi penjual, sama dengan nilai kolom merchants.verification_status.
type VerificationStatus = "pending" | "needs_fix" | "verified" | "suspended";
// Satu penjual demo: `points` = id titik temu, `note` = catatan perbaikan, `reason` = alasan penangguhan.
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

/**
 * Memeriksa apakah alamat database menunjuk ke komputer sendiri.
 * @param url alamat database `mysql://…`
 * @returns `true` untuk localhost, 127.0.0.1, atau [::1]; `false` untuk host lain atau alamat yang tidak bisa dibaca
 */
export function isLocalHost(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Membuat satu penjual demo (akun, toko, titik temu, menu) dalam satu transaksi, yaitu rangkaian perubahan database
// yang disimpan semua atau dibatalkan semua. Mengembalikan false bila nomor HP-nya sudah terdaftar (sudah pernah
// dibuat), jadi skrip aman dijalankan berulang.
async function createDemoMerchant(demo: DemoMerchant, password: string): Promise<boolean> {
  // Lewati bila akun dengan nomor ini sudah ada; sisanya dibuat dalam satu transaksi.
  const [existing] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE phone = ?", [demo.phone]);
  if (existing.length) return false;
  await dalamTransaksi(async (conn) => {
    // 1. Buat akun penjual dan tokonya; tanggal verifikasi/penangguhan diisi sesuai status.
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
    // 2. Hubungkan titik temu dan tambahkan menu (tanpa foto, stok harian 20).
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

// Membuat log aktivitas admin untuk perubahan status penjual demo, atas nama admin pertama. Log hanya bermakna bila
// sudah ada admin ("no-admin" bila belum), dan dilewati bila sudah pernah dibuat.
async function createDemoAuditLogs(): Promise<"ok" | "no-admin"> {
  // 1. Perlu satu admin sebagai pelaku; lewati bila log demo sudah ada.
  const [admins] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!admins.length) return "no-admin";
  const [existingLogs] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM admin_audit_logs WHERE reason = 'Data demo'",
  );
  if (Number(existingLogs[0].n) > 0) return "ok";
  // 2. Ambil penjual demo beserta statusnya.
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
    // 3. Satu log per penjual, dicatat seolah admin mengubah status dari "pending" ke status demo.
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

/**
 * Menjalankan skrip data demo. Ditolak di production, dan hanya boleh ke database lokal atau database uji (nama
 * berakhiran `_test`) kecuali diberi opsi `--paksa`. Sandi hanya dari env dan tidak pernah dicetak.
 * @param env  variabel lingkungan; dibaca NODE_ENV, DATABASE_URL, dan DEMO_PASSWORD
 * @param args argumen baris perintah, contoh `["--paksa"]`
 * @returns kode keluar proses: 0 berhasil, 1 gagal (pesannya sudah dicetak)
 */
export async function run(env: NodeJS.ProcessEnv, args: string[] = []): Promise<number> {
  // 1. Tolak lingkungan production dan database selain lokal/uji.
  if (env.NODE_ENV === "production") {
    console.error("Data demo tidak boleh dibuat di lingkungan produksi.");
    return 1;
  }
  const url = env.DATABASE_URL ?? config.DATABASE_URL;
  // Database uji (nama berakhiran _test, contoh di TiDB) juga boleh: isinya memang dikosongkan setiap kali test.
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
  // 2. Sandi demo wajib ada dan memenuhi aturan sandi biasa.
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
  // 3. Buat penjual demo yang belum ada, lalu log aktivitas admin.
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

// Hanya berjalan bila file ini dijalankan langsung (bukan diimpor test); pool database ditutup sebelum keluar.
if (require.main === module) {
  run(process.env, process.argv.slice(2))
    .then((code) => db.end().then(() => process.exit(code)))
    .catch((error) => {
      console.error((error as Error).message);
      process.exit(1);
    });
}
