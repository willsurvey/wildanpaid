// =============================================================================
// TEST SCRIPT — Validasi Koneksi Bot Telegram dan Konfigurasi Topik
// =============================================================================
// Script ini digunakan HANYA untuk memastikan Bot Telegram Anda
// bisa mengirim pesan dengan benar ke grup dan topik yang dituju.
// =============================================================================

require('dotenv').config();
const Notifier = require('./src/notifier');
const { createLogger } = require('./src/logger');

const log = createLogger('TEST');

async function runTest() {
  log.info('🚀 Memulai simulasi pengiriman pesan Telegram...');

  // Cek apakah variabel .env sudah terisi
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    log.error('❌ TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diisi di .env!');
    process.exit(1);
  }

  const notifier = new Notifier();
  
  // Matikan sistem antrian (queue) internal Notifier agar cepat selesai untuk test
  const TELEGRAM = require('./src/config').TELEGRAM;
  TELEGRAM.MIN_SEND_INTERVAL_MS = 500; // Cukup 0.5 detik antar pesan simulasi

  // 1. Simulasi INSTITUTIONAL BUYING
  log.info('📡 Mengirim simulasi INSTITUTIONAL BUYING...');
  notifier.handleSignal({
    type: 'INSTITUTIONAL_BUYING',
    symbol: 'BBCA',
    buyValue: 15_500_000_000,
    sellValue: 2_000_000_000,
    netInflow: 13_500_000_000,
    buyDominance: 0.88,
    buyFrequency: 45,
    whaleCount: 5,
    price: 9800,
    pctChange: 1.5,
    timestamp: new Date()
  });

  // 2. Simulasi WHALE BUY
  log.info('📡 Mengirim simulasi WHALE BUY...');
  notifier.handleSignal({
    type: 'WHALE_BUY',
    symbol: 'MBMA',
    price: 610,
    lot: 50000,
    value: 3_050_000_000,
    pctChange: 3.5,
    tier: 'MEGA',
    timestamp: new Date()
  });

  // 3. Simulasi RAPID MOMENTUM
  log.info('📡 Mengirim simulasi RAPID MOMENTUM...');
  notifier.handleSignal({
    type: 'RAPID_MOMENTUM',
    symbol: 'KRYA',
    frequency: 55,
    windowSeconds: 10,
    totalValue: 850_000_000,
    price: 55,
    pctChange: 10.2,
    timestamp: new Date()
  });

  // 4. Simulasi DISTRIBUTION WARNING
  log.info('📡 Mengirim simulasi DISTRIBUTION WARNING...');
  notifier.handleSignal({
    type: 'DISTRIBUTION_WARNING',
    symbol: 'GOTO',
    buyValue: 2_800_000_000,
    sellValue: 25_400_000_000,
    netOutflow: 22_600_000_000,
    sellDominance: 0.90,
    price: 52,
    pctChange: -5.4,
    timestamp: new Date()
  });

  // Tunggu antrian selesai dikirim (beri waktu 15 detik karena Telegram butuh waktu)
  log.info('⏳ Menunggu semua pesan terkirim...');
  await new Promise(resolve => setTimeout(resolve, 15000));
  
  const stats = notifier.getStats();
  if (stats.totalErrors === 0 && stats.totalSent === 4) {
    log.info('✅ SELAMAT! Semua tes berhasil. Bot Telegram Anda siap bekerja!');
  } else {
    log.error(`❌ UJI COBA GAGAL. Pesan Terkirim: ${stats.totalSent}, Error: ${stats.totalErrors}`);
    log.error('Mohon periksa kembali Token, Chat ID, dan ID Topik Anda di .env');
  }

  process.exit(0);
}

runTest();
