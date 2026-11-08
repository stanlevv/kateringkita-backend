-- KateringKita — skema target (MySQL 8 / TiDB)
-- Sumber kebenaran: docs/ERD.md. Impor ke https://drawdb.app (Import → MySQL) untuk diagram.
-- Implementasi di be/ dibagi menjadi migrasi bernomor; file ini adalah gambaran akhirnya.
-- Uang: INT Rupiah. Waktu: DATETIME dalam UTC; "hari ini" dihitung di zona Asia/Jakarta oleh aplikasi.

-- ---------------------------------------------------------------- master data

CREATE TABLE merchant_types (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE categories (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(60)  NOT NULL UNIQUE,
  slug        VARCHAR(60)  NOT NULL UNIQUE,
  icon        VARCHAR(40)  NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE pickup_points (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL UNIQUE,
  description VARCHAR(255) NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE app_settings (
  setting_key   VARCHAR(60)  PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------- akun

CREATE TABLE users (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  role                     ENUM('admin','merchant','customer') NOT NULL,
  full_name                VARCHAR(150) NOT NULL,
  email                    VARCHAR(150) NULL UNIQUE,
  phone                    VARCHAR(20)  NOT NULL UNIQUE,
  password_hash            VARCHAR(255) NOT NULL,
  avatar_url               VARCHAR(500) NULL,
  favorite_pickup_point_id INT          NULL,
  is_active                BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (favorite_pickup_point_id) REFERENCES pickup_points(id) ON DELETE SET NULL
);

CREATE TABLE auth_sessions (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  jti         CHAR(36)     NOT NULL UNIQUE,          -- id token di dalam JWT
  client      ENUM('web','mobile') NOT NULL,
  user_agent  VARCHAR(255) NULL,
  expires_at  DATETIME     NOT NULL,
  revoked_at  DATETIME     NULL,                      -- diisi saat logout
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_user (user_id)
);

CREATE TABLE password_resets (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,                  -- OTP 6 digit, di-hash
  attempts    TINYINT      NOT NULL DEFAULT 0,        -- maks 5
  expires_at  DATETIME     NOT NULL,                  -- +10 menit
  used_at     DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_resets_user (user_id, created_at)
);

-- ---------------------------------------------------------------- penjual

CREATE TABLE merchants (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  user_id               INT          NOT NULL UNIQUE,
  merchant_type_id      INT          NOT NULL,
  business_name         VARCHAR(150) NOT NULL,
  slug                  VARCHAR(160) NOT NULL UNIQUE,
  description           VARCHAR(500) NULL,
  address               VARCHAR(255) NOT NULL,
  wa_number             VARCHAR(20)  NOT NULL,          -- tujuan pesan WhatsApp
  logo_url              VARCHAR(500) NULL,
  service_mode          ENUM('daily','event','both') NOT NULL DEFAULT 'both',
  open_time             TIME         NOT NULL DEFAULT '07:00:00',
  close_time            TIME         NOT NULL DEFAULT '16:00:00',
  is_open               BOOLEAN      NOT NULL DEFAULT TRUE, -- "Status Dapur"
  hold_minutes          TINYINT      NOT NULL DEFAULT 5,
  daily_revenue_target  INT          NOT NULL DEFAULT 0,
  qris_image_url        VARCHAR(500) NULL,              -- QRIS statis opsional
  wa_template           TEXT         NULL,              -- NULL = templat bawaan
  rating_avg            DECIMAL(3,2) NOT NULL DEFAULT 0,
  rating_count          INT          NOT NULL DEFAULT 0,
  verified_at           DATETIME     NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)          REFERENCES users(id)          ON DELETE RESTRICT,
  FOREIGN KEY (merchant_type_id) REFERENCES merchant_types(id) ON DELETE RESTRICT
);

CREATE TABLE merchant_pickup_points (
  merchant_id     INT NOT NULL,
  pickup_point_id INT NOT NULL,
  PRIMARY KEY (merchant_id, pickup_point_id),
  FOREIGN KEY (merchant_id)     REFERENCES merchants(id)     ON DELETE CASCADE,
  FOREIGN KEY (pickup_point_id) REFERENCES pickup_points(id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------- menu

CREATE TABLE menus (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  merchant_id    INT          NOT NULL,
  category_id    INT          NOT NULL,
  name           VARCHAR(80)  NOT NULL,
  description    VARCHAR(500) NULL,
  image_url      VARCHAR(500) NULL,
  unit_label     VARCHAR(30)  NOT NULL DEFAULT 'porsi',   -- "porsi", "box", "isi 5"
  price          INT          NOT NULL,                   -- > hpp, >= 1000
  hpp            INT          NOT NULL,                   -- tidak pernah dikirim ke publik
  daily_quota    INT          NOT NULL DEFAULT 0,         -- kuota bawaan tiap hari baru
  quota_today    INT          NOT NULL DEFAULT 0,         -- kuota hari ini (bisa +/- oleh penjual)
  sold_today     INT          NOT NULL DEFAULT 0,
  held_today     INT          NOT NULL DEFAULT 0,
  stock_date     DATE         NULL,                       -- tanggal WIB untuk 3 kolom di atas
  prep_minutes   SMALLINT     NOT NULL DEFAULT 15,
  is_preorder    BOOLEAN      NOT NULL DEFAULT FALSE,
  preorder_days  TINYINT      NOT NULL DEFAULT 0,         -- mis. 2 = "Pre-Order H-2"
  min_order_qty  INT          NOT NULL DEFAULT 1,
  sold_total     INT          NOT NULL DEFAULT 0,
  rating_avg     DECIMAL(3,2) NOT NULL DEFAULT 0,
  rating_count   INT          NOT NULL DEFAULT 0,
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  deleted_at     DATETIME     NULL,                       -- soft delete
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)  ON DELETE RESTRICT,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
  CHECK (price >= 1000 AND hpp >= 0 AND price > hpp),
  CHECK (quota_today >= sold_today + held_today),
  INDEX idx_menus_merchant (merchant_id, is_active),
  INDEX idx_menus_category (category_id, is_active)
);

CREATE TABLE menu_options (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  menu_id      INT         NOT NULL,
  name         VARCHAR(60) NOT NULL,                      -- "Sambal Pisah", "Keju Spesial"
  extra_price  INT         NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE
);

CREATE TABLE favorites (
  user_id    INT      NOT NULL,
  menu_id    INT      NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, menu_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- promo

CREATE TABLE promos (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  merchant_id     INT          NULL,                      -- NULL = promo platform
  code            VARCHAR(30)  NOT NULL UNIQUE,
  description     VARCHAR(255) NULL,
  type            ENUM('percent','fixed','free_service_fee') NOT NULL,
  value           INT          NOT NULL DEFAULT 0,        -- persen atau Rupiah
  max_discount    INT          NULL,
  min_subtotal    INT          NOT NULL DEFAULT 0,
  quota           INT          NULL,                      -- NULL = tanpa batas
  used_count      INT          NOT NULL DEFAULT 0,
  per_user_limit  INT          NOT NULL DEFAULT 1,
  starts_at       DATETIME     NOT NULL,
  ends_at         DATETIME     NOT NULL,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- pesanan

CREATE TABLE orders (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  code             VARCHAR(20)  NOT NULL UNIQUE,          -- KK-YYYYMMDD-XXXX
  customer_id      INT          NOT NULL,
  merchant_id      INT          NOT NULL,
  pickup_point_id  INT          NOT NULL,
  status           ENUM('holding','confirmed','cooking','ready','completed','cancelled','expired') NOT NULL DEFAULT 'holding',
  customer_name    VARCHAR(150) NOT NULL,                 -- salinan saat checkout
  customer_phone   VARCHAR(20)  NOT NULL,
  note             VARCHAR(255) NULL,
  subtotal         INT          NOT NULL,
  discount         INT          NOT NULL DEFAULT 0,
  service_fee      INT          NOT NULL DEFAULT 0,
  total            INT          NOT NULL,
  promo_id         INT          NULL,
  payment_method   ENUM('qris','va','cod') NOT NULL,
  payment_status   ENUM('unpaid','pending','paid','failed','refunded') NOT NULL DEFAULT 'unpaid',
  hold_until       DATETIME     NOT NULL,
  pickup_at        DATETIME     NULL,                     -- untuk pre-order
  confirmed_at     DATETIME     NULL,
  cooking_at       DATETIME     NULL,
  ready_at         DATETIME     NULL,
  completed_at     DATETIME     NULL,
  cancelled_at     DATETIME     NULL,
  cancelled_by     ENUM('customer','merchant','system') NULL,
  cancel_reason    VARCHAR(255) NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id)     REFERENCES users(id)         ON DELETE RESTRICT,
  FOREIGN KEY (merchant_id)     REFERENCES merchants(id)     ON DELETE RESTRICT,
  FOREIGN KEY (pickup_point_id) REFERENCES pickup_points(id) ON DELETE RESTRICT,
  FOREIGN KEY (promo_id)        REFERENCES promos(id)        ON DELETE SET NULL,
  INDEX idx_orders_merchant (merchant_id, status, created_at),
  INDEX idx_orders_customer (customer_id, created_at),
  INDEX idx_orders_hold (status, hold_until)
);

CREATE TABLE order_items (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id     BIGINT      NOT NULL,
  menu_id      INT         NOT NULL,
  menu_name    VARCHAR(80) NOT NULL,                      -- salinan
  unit_price   INT         NOT NULL,                      -- harga + opsi, salinan
  hpp          INT         NOT NULL,                      -- salinan, untuk laporan laba
  qty          INT         NOT NULL,
  options      JSON        NULL,                          -- [{"id":3,"name":"Sambal Pisah","extra_price":0}]
  line_total   INT         NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_id)  REFERENCES menus(id)  ON DELETE RESTRICT,
  CHECK (qty > 0)
);

CREATE TABLE order_status_logs (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id      BIGINT   NOT NULL,
  from_status   VARCHAR(20) NULL,
  to_status     VARCHAR(20) NOT NULL,
  actor_user_id INT      NULL,                            -- NULL = sistem (expired, webhook)
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id)      REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)  ON DELETE SET NULL,
  INDEX idx_logs_order (order_id)
);

CREATE TABLE payments (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id      BIGINT       NOT NULL,
  method        ENUM('qris','va','cod') NOT NULL,
  provider      ENUM('midtrans','manual') NOT NULL,
  provider_ref  VARCHAR(100) NULL UNIQUE,                 -- transaction_id dari gateway
  bank          VARCHAR(20)  NULL,                        -- untuk VA: bca, mandiri, bri, bni
  va_number     VARCHAR(40)  NULL,
  qr_string     TEXT         NULL,
  amount        INT          NOT NULL,
  status        ENUM('pending','paid','failed','expired','refunded') NOT NULL DEFAULT 'pending',
  expires_at    DATETIME     NULL,
  paid_at       DATETIME     NULL,
  raw_payload   JSON         NULL,                        -- notifikasi terakhir dari gateway
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_payments_order (order_id)
);

CREATE TABLE promo_redemptions (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  promo_id    INT      NOT NULL,
  order_id    BIGINT   NOT NULL UNIQUE,
  user_id     INT      NOT NULL,
  amount      INT      NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (promo_id) REFERENCES promos(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  INDEX idx_redemptions_user (promo_id, user_id)
);

CREATE TABLE reviews (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id    BIGINT   NOT NULL,
  menu_id     INT      NOT NULL,
  customer_id INT      NOT NULL,
  rating      TINYINT  NOT NULL,
  comment     VARCHAR(500) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_review (order_id, menu_id),
  FOREIGN KEY (order_id)    REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_id)     REFERENCES menus(id)  ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES users(id)  ON DELETE CASCADE,
  CHECK (rating BETWEEN 1 AND 5)
);

CREATE TABLE notifications (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  type        VARCHAR(40)  NOT NULL,                      -- order_status, promo, system
  title       VARCHAR(120) NOT NULL,
  body        VARCHAR(255) NOT NULL,
  data        JSON         NULL,                          -- {"order_code":"KK-..."}
  read_at     DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_user (user_id, read_at, created_at)
);

-- ---------------------------------------------------------------- seed master

INSERT INTO merchant_types (id, name) VALUES
  (1, 'Katering Nasi Box & Harian'),
  (2, 'Kudapan, Snack & Kue'),
  (3, 'Kedai Minuman & Es'),
  (4, 'Paket Custom & Prasmanan Acara'),
  (5, 'Danus Organisasi Mahasiswa');

INSERT INTO categories (id, name, slug, icon, sort_order) VALUES
  (1, 'Nasi Box',      'nasi-box',      'bowl',    1),
  (2, 'Ayam',          'ayam',          'drumstick', 2),
  (3, 'Martabak',      'martabak',      'martabak', 3),
  (4, 'Snack & Kue',   'snack',         'cookie',  4),
  (5, 'Minuman',       'minuman',       'cup',     5),
  (6, 'Paket Acara',   'paket-acara',   'package', 6),
  (7, 'Danusan',       'danusan',       'heart',   7);

INSERT INTO pickup_points (id, name) VALUES
  (1, 'Gedung Vokasi UB (Lt. 2)'),
  (2, 'Kantin Vokasi UB'),
  (3, 'Gazebo Fakultas Ilmu Komputer');

INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('service_fee', '0'),
  ('timezone', 'Asia/Jakarta');
