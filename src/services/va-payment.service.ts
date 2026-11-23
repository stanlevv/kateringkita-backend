// Isi file: pembayaran non-tunai lewat Midtrans, yaitu membuat Virtual Account (VA), kode QRIS, dan halaman bayar
// Snap untuk sebuah pesanan, lalu menerima webhook Midtrans yang mengabarkan pembayaran lunas. Alurnya
// routes/order.ts → handlers/order.handler.ts → file ini → database; table.service memakai halaman Snap dari sini.
//
// Istilah:
// - Midtrans: perusahaan penyalur pembayaran. Uang pembeli masuk ke Midtrans, lalu Midtrans memberi tahu server kita.
// - Virtual Account (VA): nomor rekening sementara di satu bank yang hanya berlaku untuk satu pesanan.
// - QRIS: kode QR standar Bank Indonesia yang bisa dibayar dari aplikasi bank atau dompet digital mana pun.
// - Snap: halaman bayar milik Midtrans; pembeli memilih sendiri cara bayarnya (QRIS, e-wallet, VA) di sana.
// - Webhook (notifikasi Midtrans): permintaan HTTP yang dikirim server Midtrans ke server kita saat status bayar
//   berubah.
// - Batas waktu (hold): pesanan `holding` menahan stok sampai kolom `orders.hold_until`. VA, QRIS, dan halaman Snap
//   diberi masa berlaku yang tidak melewati batas ini, supaya pembeli tidak bisa membayar pesanan yang sudah lewat.
// - Idempoten: permintaan yang sama boleh dikirim berkali-kali (misalnya tombol ditekan dua kali) dan hasilnya tetap
//   satu VA/QRIS/halaman bayar, tidak dobel.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import {
  VaBank,
  createMidtransQris,
  createSnapPayment,
  createMidtransVa,
  isValidNotification,
  getMidtransStatus,
} from "../utils/midtrans";
import { withTransaction } from "./admin-audit.service";
import { getMyOrder } from "./order.service";
import { transitionOrder } from "./order-status.service";

// Galat 409: pesanan tidak dalam keadaan yang bisa dibayar.
const conflict = (message: string) => new AppError(409, "CONFLICT", message);

/**
 * Memeriksa bahwa alamat kembali (halaman web yang dibuka setelah bayar) milik web KateringKita sendiri, yaitu salah
 * satu alamat di env `CORS_ORIGIN` (atau `http://localhost:3000` bila daftarnya kosong). Tanpa cek ini halaman bayar
 * bisa dipakai untuk mengalihkan pembeli ke situs lain.
 * @param url alamat lengkap yang dikirim aplikasi web
 * @returns `true` bila asal alamatnya (skema + host + port) diizinkan; `false` bila tidak, atau bila teksnya bukan
 *   alamat yang sah
 */
export const isAllowedOrigin = (url: string) => {
  try {
    return (env.CORS_ORIGIN.length ? env.CORS_ORIGIN : ["http://localhost:3000"]).includes(new URL(url).origin);
  } catch {
    return false;
  }
};
// Galat 400 dengan pesan di kolom `kembali` (nama kolom isi permintaan, kontrak dengan aplikasi web).
const returnUrlNotAllowed = () =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { kembali: ["Alamat kembali tidak diizinkan."] });

/**
 * Potongan SQL yang mengambil alamat halaman Snap terbaru milik sebuah pesanan (baris `payments` bercara bayar
 * `online`). Hasilnya NULL bila halaman Snap belum pernah dibuat. Harus dipakai dalam kueri yang memberi tabel
 * `orders` alias `o`.
 */
export const PAYMENT_URL_SQL =
  "(SELECT redirect_url FROM payments p WHERE p.order_id = o.id AND p.method = 'online' ORDER BY p.id DESC LIMIT 1)";
/**
 * Daftar kolom SELECT yang dibutuhkan {@link openSnapPayment}; tabel `orders` harus beralias `o`. `menit` = sisa
 * menit sampai batas waktu pesanan, dibulatkan ke bawah oleh TIMESTAMPDIFF. `url` = halaman Snap yang sudah ada.
 */
export const SNAP_COLUMNS = `o.id, o.total, o.status, o.payment_method, o.payment_status,
  TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit, ${PAYMENT_URL_SQL} AS url`;

/**
 * Membuka halaman bayar Snap untuk pesanan yang masih menunggu bayar, atau memakai ulang halaman yang sudah pernah
 * dibuat (idempoten). Midtrans dipanggil di luar transaksi database, supaya baris pesanan tidak terkunci selama
 * menunggu jawaban Midtrans. Jumlah yang ditagih adalah `orders.total`.
 * @param order     baris pesanan hasil SELECT {@link SNAP_COLUMNS}
 * @param code      kode pesanan, dipakai sebagai `order_id` di Midtrans
 * @param returnUrl halaman web yang dibuka setelah bayar; kosong untuk aplikasi mobile. Pemanggil yang memeriksa
 *                  bahwa alamat ini diizinkan.
 * @returns alamat halaman Snap
 * @throws 409 pesanan tidak sedang menunggu pembayaran atau sudah lunas, 409 batas waktu pesanan sudah habis
 *   (sisa kurang dari 1 menit), 502/503 Midtrans tidak menjawab atau belum diaktifkan
 */
export async function openSnapPayment(order: RowDataPacket, code: string, returnUrl?: string): Promise<string> {
  // 1. Hanya pesanan `holding` yang belum lunas boleh dibayar; halaman yang sudah ada langsung dikembalikan.
  if (order.status !== "holding" || order.payment_status === "paid")
    throw conflict("Pesanan ini tidak menunggu pembayaran.");
  if (order.url) return order.url as string;
  // 2. Masa berlaku halaman = sisa menit yang dibulatkan ke bawah, jadi halaman tutup sebelum batas waktu habis.
  const minutesLeft = Number(order.menit);
  if (minutesLeft < 1) throw conflict("Batas waktu pesanan sudah habis.");
  // 3. Minta halaman Snap ke Midtrans, lalu simpan sebagai baris `payments` berstatus `pending`.
  const { redirect_url } = await createSnapPayment(code, order.total, minutesLeft, returnUrl);
  await db.query(
    `INSERT INTO payments (order_id, method, provider, amount, status, expires_at, redirect_url)
     VALUES (?, 'online', 'midtrans', ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
    [order.id, order.total, minutesLeft, redirect_url],
  );
  // 4. Status bayar pesanan menjadi `pending` (sedang dibayar); pesanan belum dianggap lunas.
  await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [order.id]);
  return redirect_url;
}

/**
 * Membuka halaman bayar online Snap (QRIS, e-wallet, atau VA pilihan pembeli) untuk pre-order milik pembeli yang
 * login. Aplikasi web mengirim alamat kembali; aplikasi mobile cukup membuka `payment_url` di detail pesanan.
 * @param userId    id pembeli yang login
 * @param code      kode pesanan
 * @param returnUrl halaman web yang dibuka setelah bayar; boleh kosong
 * @returns detail pesanan terbaru seperti getMyOrder, termasuk alamat halaman bayar
 * @throws 400 alamat kembali tidak diizinkan (pesan di kolom `kembali`), 404 pesanan tidak ada atau milik pembeli
 *   lain, 409 pesanan tidak memakai bayar online, tidak menunggu pembayaran, atau batas waktunya habis,
 *   502/503 Midtrans tidak menjawab atau belum diaktifkan
 */
export async function payOnline(userId: number, code: string, returnUrl?: string) {
  if (returnUrl !== undefined && !isAllowedOrigin(returnUrl)) throw returnUrlNotAllowed();
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT ${SNAP_COLUMNS} FROM orders o WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (order.payment_method !== "online") throw conflict("Pesanan ini tidak memakai bayar online.");
  await openSnapPayment(order, code, returnUrl);
  return getMyOrder(userId, code);
}

/**
 * Membuat kode QRIS yang digambar langsung di aplikasi untuk pesanan bercara bayar `online`. Satu pesanan hanya punya
 * satu QRIS (idempoten); Midtrans dipanggil di luar transaksi database. Jumlah yang ditagih adalah `orders.total`.
 * @param userId id pembeli yang login
 * @param code   kode pesanan
 * @returns detail pesanan terbaru seperti getMyOrder, termasuk isi kode QR
 * @throws 404 pesanan tidak ada atau milik pembeli lain, 409 pesanan tidak memakai bayar online, tidak menunggu
 *   pembayaran, sudah lunas, atau batas waktunya habis, 409 pesanan sudah mulai dibayar lewat halaman Snap,
 *   502/503 Midtrans tidak menjawab atau belum diaktifkan
 */
export async function createQris(userId: number, code: string) {
  // 1. Ambil pesanan milik pembeli ini, sisa menitnya, dan apakah QRIS-nya sudah pernah dibuat (`ada`).
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.total, o.status, o.payment_method, o.payment_status, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit,
       EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = 'qris') AS ada
     FROM orders o WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  // 2. Tolak bila pesanan tidak ada, bukan bayar online, atau tidak sedang menunggu pembayaran.
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (order.payment_method !== "online") throw conflict("Pesanan ini tidak memakai bayar online.");
  if (order.status !== "holding" || order.payment_status === "paid")
    throw conflict("Pesanan ini tidak menunggu pembayaran.");
  // 3. QRIS baru hanya dibuat bila belum ada; kalau sudah ada, langsung ke langkah 4.
  if (!Number(order.ada)) {
    // Sisa menit dibulatkan ke bawah, jadi QR kedaluwarsa sebelum batas waktu pesanan habis.
    const minutesLeft = Number(order.menit);
    if (minutesLeft < 1) throw conflict("Batas waktu pesanan sudah habis.");
    const qris = await createMidtransQris(code, order.total, minutesLeft);
    try {
      await db.query(
        `INSERT INTO payments (order_id, method, provider, provider_ref, qr_string, redirect_url, amount, status, expires_at)
         VALUES (?, 'qris', 'midtrans', ?, ?, ?, ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
        [order.id, qris.transaction_id, qris.qr_string, qris.qr_url, order.total, minutesLeft],
      );
    } catch (error) {
      // Penjaga cadangan: provider_ref unik, jadi bila transaksi Midtrans yang sama sudah tersimpan, simpanan kedua
      // ditolak database dan aman diabaikan. Permintaan kembar biasanya tidak sampai sini: Midtrans menjawab 406 untuk
      // kode pesanan yang sudah dipakai, lalu createMidtransQris melempar 409.
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
    }
    await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [
      order.id,
    ]);
  }
  // 4. Kirim detail pesanan terbaru (berisi QRIS) ke aplikasi.
  return getMyOrder(userId, code);
}

/**
 * Membuat Virtual Account untuk pesanan bercara bayar `va` milik pembeli yang masih menunggu bayar. Midtrans
 * dipanggil di luar transaksi database supaya baris pesanan tidak terkunci selama menunggu jawaban Midtrans.
 * Idempoten: VA yang sudah ada dikembalikan. Jumlah yang ditagih adalah `orders.total`.
 * @param userId id pembeli yang login
 * @param code   kode pesanan
 * @param bank   bank tujuan VA pilihan pembeli
 * @returns detail pesanan terbaru seperti getMyOrder, termasuk bank dan nomor VA
 * @throws 404 pesanan tidak ada atau milik pembeli lain, 409 pesanan bukan bayar VA, tidak menunggu pembayaran,
 *   sudah lunas, atau batas waktunya habis, 502/503 Midtrans tidak menjawab atau belum diaktifkan
 */
// shortcut: satu VA per pesanan (bank pertama dipakai); ganti bank butuh order_id Midtrans baru, tambahkan bila diminta
export async function createVa(userId: number, code: string, bank: VaBank) {
  // 1. Ambil pesanan milik pembeli ini, sisa menitnya, dan apakah VA-nya sudah pernah dibuat (`ada`).
  const [[order]] = await db.query<RowDataPacket[]>(
    `SELECT o.id, o.total, o.status, o.payment_method, o.payment_status, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), o.hold_until) AS menit,
       EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = 'va') AS ada
     FROM orders o WHERE o.code = ? AND o.customer_id = ?`,
    [code, userId],
  );
  // 2. Tolak bila pesanan tidak ada, bukan bayar VA, atau tidak sedang menunggu pembayaran.
  if (!order) throw new AppError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  if (order.payment_method !== "va" || order.status !== "holding" || order.payment_status === "paid") {
    throw conflict("Pesanan ini tidak menunggu pembayaran Virtual Account.");
  }
  // 3. VA baru hanya dibuat bila belum ada; kalau sudah ada, langsung ke langkah 4.
  if (!Number(order.ada)) {
    // Sisa menit dibulatkan ke bawah: VA tutup sebelum batas waktu pesanan habis, jadi transfer tidak masuk ke
    // pesanan yang sudah lewat waktu.
    const minutesLeft = Number(order.menit);
    if (minutesLeft < 1) throw conflict("Batas waktu pesanan sudah habis.");
    const virtualAccount = await createMidtransVa(code, order.total, bank, minutesLeft);
    try {
      await db.query(
        `INSERT INTO payments (order_id, method, provider, provider_ref, bank, va_number, amount, status, expires_at)
         VALUES (?, 'va', 'midtrans', ?, ?, ?, ?, 'pending', DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
        [
          order.id,
          virtualAccount.transaction_id,
          virtualAccount.bank,
          virtualAccount.va_number,
          order.total,
          minutesLeft,
        ],
      );
    } catch (error) {
      // Dua permintaan kembar: permintaan kedua dijawab 406 oleh Midtrans lalu memakai transaksi yang sama, jadi
      // provider_ref-nya kembar dan simpanan kedua ditolak database. Itu aman diabaikan: VA-nya sudah tersimpan.
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
    }
    await db.query("UPDATE orders SET payment_status = 'pending' WHERE id = ? AND payment_status = 'unpaid'", [
      order.id,
    ]);
  }
  // 4. Kirim detail pesanan terbaru (berisi nomor VA) ke aplikasi.
  return getMyOrder(userId, code);
}

// Status transaksi Midtrans → status baris `payments`. Status lain (misalnya `pending`) tidak mengubah apa pun.
const PAYMENT_STATUS_FROM_MIDTRANS: Record<string, "paid" | "expired" | "failed"> = {
  settlement: "paid",
  expire: "expired",
  cancel: "failed",
  deny: "failed",
  failure: "failed",
};

/**
 * Menerima webhook dari Midtrans untuk VA, QRIS, dan halaman Snap (rute publik tanpa login). Pesanan baru dianggap
 * lunas bila tiga hal terpenuhi: tanda tangan webhook sah, status yang ditanyakan ulang ke Midtrans adalah
 * `settlement`, dan nominal dari Midtrans sama persis dengan `amount` baris pembayaran yang tersimpan. Saat lunas,
 * pesanan dipindah dari `holding` ke `confirmed` oleh sistem (stok terjual, pembeli diberi notifikasi) dan baris
 * pembayaran ditandai `paid`. Status kedaluwarsa atau gagal hanya mengubah baris pembayaran menjadi `expired` atau
 * `failed`; pesanannya sendiri tidak diubah di sini.
 * Webhook yang sama boleh datang berkali-kali: baris yang sudah lunas atau sudah di-refund tidak diubah lagi.
 * @param notification isi JSON webhook dari Midtrans
 * @returns tidak ada; webhook yang tidak relevan (status lain, pembayaran tidak dikenal, nominal beda) diabaikan
 * @throws 403 tanda tangan webhook tidak sah, 502/503 Midtrans tidak bisa ditanya ulang (Midtrans akan mengirim
 *   ulang webhook nanti)
 */
export async function handleMidtransNotification(notification: Record<string, unknown>): Promise<void> {
  // 1. Tolak webhook palsu; abaikan status yang tidak mengubah apa pun (misalnya `pending`).
  if (!isValidNotification(notification)) throw new AppError(403, "FORBIDDEN", "Tanda tangan notifikasi tidak sah.");
  if (!PAYMENT_STATUS_FROM_MIDTRANS[String(notification.transaction_status)]) return;
  const code = String(notification.order_id);
  // 2. Tanda tangan hanya mencakup order_id, status_code, dan gross_amount, jadi transaction_status di isi webhook
  //    bisa diganti orang yang memegang webhook bertanda tangan yang bocor. Karena itu status, nominal, dan
  //    transaction_id diambil dari Midtrans langsung (Get Status), bukan dari isi webhook.
  const midtransStatus = await getMidtransStatus(code);
  const newStatus = PAYMENT_STATUS_FROM_MIDTRANS[String(midtransStatus.transaction_status)];
  if (!newStatus || String(midtransStatus.order_id) !== code) return;
  // 3. Sisanya dalam satu transaksi database: semua perubahan tersimpan bersama atau dibatalkan bersama.
  await withTransaction(async (conn) => {
    // 4. Cari baris pembayaran Midtrans pesanan ini (VA, Snap `online`, atau QRIS). Pesanan online bisa punya baris
    //    Snap dan QRIS sekaligus, jadi baris yang provider_ref-nya sama dengan transaction_id diutamakan.
    const transactionId = typeof midtransStatus.transaction_id === "string" ? midtransStatus.transaction_id : null;
    const [[payment]] = await conn.query<RowDataPacket[]>(
      `SELECT p.id, p.status, p.amount FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.code = ? AND p.method IN ('va', 'online', 'qris') AND p.provider = 'midtrans'
       ORDER BY (p.provider_ref <=> ?) DESC, p.id LIMIT 1`,
      [code, transactionId],
    );
    // 5. Abaikan bila baris tidak ada, sudah lunas, atau sudah di-refund. Nominal yang beda dicatat di log lalu
    //    diabaikan.
    if (!payment || payment.status === "paid" || payment.status === "refunded") return;
    if (Number(midtransStatus.gross_amount) !== payment.amount) {
      console.error(
        `Notifikasi Midtrans ${code}: nominal ${String(midtransStatus.gross_amount)} ≠ ${payment.amount}, diabaikan`,
      );
      return;
    }
    // 6. Lunas: pindahkan pesanan ke `confirmed`. Urutan kunci baris sama dengan transisi lain (users → orders →
    //    menus), payments dikunci terakhir. Bila pesanan sudah lewat batas waktu atau batal, transisi ditolak 409;
    //    galat itu ditelan supaya pembayaran tetap tercatat lunas dan muncul di daftar refund admin.
    if (newStatus === "paid") {
      await transitionOrder(conn, code, "pay", { kind: "system" }).catch((error: unknown) => {
        if (!(error instanceof AppError) || error.status !== 409) throw error;
        console.error(`VA ${code} lunas tetapi pesanan tidak bisa dikonfirmasi: ${error.message}`);
      });
    }
    // 7. Simpan status baru, jawaban Midtrans, dan transaction_id (halaman Snap baru mengetahuinya dari webhook).
    await conn.query(
      `UPDATE payments SET status = ?, paid_at = IF(? = 'paid', UTC_TIMESTAMP(), paid_at), raw_payload = ?, provider_ref = COALESCE(provider_ref, ?)
       WHERE id = ? AND status NOT IN ('paid', 'refunded')`,
      [newStatus, newStatus, JSON.stringify(midtransStatus), transactionId, payment.id],
    );
  });
}
