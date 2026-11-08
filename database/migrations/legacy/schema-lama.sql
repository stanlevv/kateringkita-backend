-- Skema Database KateringKita (MySQL)
CREATE DATABASE IF NOT EXISTS kateringkita_db;
USE kateringkita_db;

-- 1. Tabel Roles
CREATE TABLE IF NOT EXISTS roles (
  role_id INT AUTO_INCREMENT PRIMARY KEY,
  nama_role VARCHAR(50) NOT NULL UNIQUE
);

INSERT IGNORE INTO roles (role_id, nama_role) VALUES 
(1, 'admin'),
(2, 'merchant'),
(3, 'customer');

-- 2. Tabel Jenis Usaha Merchant
CREATE TABLE IF NOT EXISTS merchant_types (
  type_id INT AUTO_INCREMENT PRIMARY KEY,
  nama_jenis VARCHAR(100) NOT NULL
);

INSERT IGNORE INTO merchant_types (type_id, nama_jenis) VALUES 
(1, 'Katering Nasi Box & Harian'),
(2, 'Kudapan, Snack & Kue'),
(3, 'Kedai Minuman & Es'),
(4, 'Paket Custom & Prasmanan Acara');

-- 3. Tabel Users
CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT NOT NULL,
  nama_lengkap VARCHAR(150) NOT NULL,
  email VARCHAR(150) NULL UNIQUE,
  no_whatsapp VARCHAR(20) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE
);

-- 4. Tabel Merchants
CREATE TABLE IF NOT EXISTS merchants (
  merchant_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  type_id INT NOT NULL,
  nama_usaha VARCHAR(150) NOT NULL,
  alamat_usaha TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (type_id) REFERENCES merchant_types(type_id) ON DELETE RESTRICT
);

-- 5. Tabel Menus (CRUD Form Lab Pertemuan 10)
CREATE TABLE IF NOT EXISTS menus (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  name VARCHAR(255) NOT NULL,
  cat ENUM('Nasi Box', 'Snack', 'Minuman', 'Paket Custom') NOT NULL,
  `desc` TEXT,
  img VARCHAR(255) DEFAULT '/menu/1.png',
  hpp INT NOT NULL,
  price INT NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  hold INT NOT NULL DEFAULT 0,
  sold INT NOT NULL DEFAULT 0,
  est VARCHAR(50) DEFAULT '15 Mnt',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

-- Data Awal Menu (Seed)
INSERT IGNORE INTO menus (id, name, cat, `desc`, img, hpp, price, stock, hold, sold, est) VALUES
(1, 'Nasi Ayam Bakar Madu Komplit', 'Nasi Box', 'Nasi pulen, paha ayam bakar madu, sambal terasi & lalapan fresh', '/menu/1.png', 12000, 18000, 6, 2, 42, '15 Mnt'),
(2, 'Risol Mayo Lumer (Isi 3)', 'Snack', 'Risol smoked beef isi telur & mayones creamy spesial', '/menu/2.png', 6500, 10000, 2, 1, 27, '10 Mnt'),
(3, 'Es Teh Solo Jumbo 22oz', 'Minuman', 'Racikan teh melati wangi khas Solo rasa sepet legit menyegarkan', '/menu/3.png', 2000, 5000, 25, 0, 32, '5 Mnt'),
(4, 'Nasi Bento Katsu Sambal Bawang', 'Nasi Box', 'Chicken katsu renyah dengan siraman sambal bawang pedas gurih', '/menu/4.png', 10500, 16000, 0, 0, 15, '15 Mnt'),
(5, 'Paket Bento & Prasmanan Acara', 'Paket Custom', 'Porsi partai besar untuk konsumsi seminar, rapat dinas & makrab', '/menu/5.png', 16000, 25000, 150, 0, 80, 'Pre-Order H-2');
