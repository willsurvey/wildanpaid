// =============================================================================
// TEST SCRIPT — Validasi Login API Stockbit
// =============================================================================
// Script ini digunakan HANYA untuk memastikan Bot bisa login
// ke akun Stockbit Anda dan mengambil JWT Token + WebSocket Key.
// =============================================================================

require('dotenv').config();
const { getCredentials } = require('./src/auth');
const { createLogger } = require('./src/logger');

const log = createLogger('TEST-LOGIN');

async function runTest() {
  log.info('🚀 Memulai simulasi Login ke Stockbit...');

  // Cek apakah variabel .env sudah terisi
  if (!process.env.STOCKBIT_USERNAME || !process.env.STOCKBIT_PASSWORD) {
    log.error('❌ STOCKBIT_USERNAME atau STOCKBIT_PASSWORD belum diisi di .env!');
    process.exit(1);
  }

  try {
    log.info(`🔑 Mencoba login dengan akun: ${process.env.STOCKBIT_USERNAME} ...`);
    
    // getCredentials() akan memanggil API Login -> Ambil JWT -> Ambil WS Key
    const credentials = await getCredentials();

    if (credentials) {
      log.info('✅ LOGIN BERHASIL!');
      log.info(`👤 User ID : ${credentials.userId}`);
      log.info(`🔑 WS Key  : ${credentials.wsKey.substring(0, 10)}... (disembunyikan untuk keamanan)`);
      log.info(`🎫 JWT     : ${credentials.jwtToken.substring(0, 20)}... (disembunyikan untuk keamanan)`);
      log.info('✅ Sistem Autentikasi Stockbit Anda berfungsi dengan sempurna!');
    } else {
      log.error('❌ LOGIN GAGAL: Kredensial tidak didapatkan.');
    }

  } catch (err) {
    log.error(`❌ TERJADI KESALAHAN SAAT LOGIN: ${err.message}`);
  }

  process.exit(0);
}

runTest();
