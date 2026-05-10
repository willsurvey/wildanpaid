// =============================================================================
// TEST SCRIPT — Kirim Semua 9 Tipe Alert ke Telegram
// =============================================================================
require('dotenv').config();
const Notifier = require('./src/notifier');
const { createLogger } = require('./src/logger');
const { TELEGRAM } = require('./src/config');

const log = createLogger('TEST-ALL');

async function runTest() {
  log.info('🚀 Memulai pengiriman semua 9 tipe alert...');

  const notifier = new Notifier();
  TELEGRAM.MIN_SEND_INTERVAL_MS = 1500;
  TELEGRAM.COOLDOWN_MS = 0; // Matikan cooldown untuk testing

  // 1. INSTITUTIONAL BUYING
  log.info('📡 [1/9] INSTITUTIONAL BUYING');
  notifier.handleSignal({
    type: 'INSTITUTIONAL_BUYING', symbol: 'BBCA',
    buyValue: 15_500_000_000, sellValue: 2_000_000_000,
    netInflow: 13_500_000_000, buyDominance: 0.88,
    buyFrequency: 45, whaleCount: 5,
    price: 9800, pctChange: 1.5, timestamp: new Date()
  });

  // 2. WHALE BUY
  log.info('📡 [2/9] WHALE BUY');
  notifier.handleSignal({
    type: 'WHALE_BUY', symbol: 'MBMA',
    price: 610, lot: 50000, value: 3_050_000_000,
    pctChange: 3.5, tier: 'MEGA', timestamp: new Date()
  });

  // 3. RAPID MOMENTUM
  log.info('📡 [3/9] RAPID MOMENTUM');
  notifier.handleSignal({
    type: 'RAPID_MOMENTUM', symbol: 'KRYA',
    frequency: 55, windowSeconds: 10,
    totalValue: 850_000_000, price: 55, pctChange: 10.2,
    timestamp: new Date()
  });

  // 4. DISTRIBUTION WARNING
  log.info('📡 [4/9] DISTRIBUTION WARNING');
  notifier.handleSignal({
    type: 'DISTRIBUTION_WARNING', symbol: 'GOTO',
    buyValue: 2_800_000_000, sellValue: 25_400_000_000,
    netOutflow: 22_600_000_000, sellDominance: 0.90,
    price: 52, pctChange: -5.4, timestamp: new Date()
  });

  // 5. LIVE MONEY FLOW +
  log.info('📡 [5/9] LIVE MONEY FLOW+');
  notifier.handleSignal({
    type: 'LIVE_MONEY_FLOW', symbol: 'BRIS',
    price: 2850, netInflow: 450_000_000,
    buyDominance: 0.72, emoji: '💧',
    isLiquid: true, isGembel: false, pctChange: 2.3,
    timestamp: new Date()
  });

  // 6. LIVE GAIN
  log.info('📡 [6/9] LIVE GAIN');
  notifier.handleSignal({
    type: 'LIVE_GAIN', symbol: 'ADRO',
    price: 3200, netInflow: 780_000_000,
    emoji: '🔥', isLiquid: true, isGembel: false,
    pctChange: 4.1, timestamp: new Date()
  });

  // 7. LIVE REBOUND
  log.info('📡 [7/9] LIVE REBOUND');
  notifier.handleSignal({
    type: 'LIVE_REBOUND', symbol: 'ANTM',
    price: 1500, netInflow: 120_000_000,
    emoji: '🥵', isLiquid: true, isGembel: false,
    pctChange: -1.2, timestamp: new Date()
  });

  // 8. LIVE MF-
  log.info('📡 [8/9] LIVE MF-');
  notifier.handleSignal({
    type: 'LIVE_MF_MINUS', symbol: 'TLKM',
    price: 3450, netInflow: -890_000_000,
    emoji: '💧', isLiquid: true, isGembel: false,
    pctChange: -2.8, timestamp: new Date()
  });

  // 9. BIG SMART MONEY
  log.info('📡 [9/9] BIG SMART MONEY');
  notifier.handleSignal({
    type: 'BIG_SMART_MONEY', symbol: 'MSIN',
    price: 500, pctChange: 2.04,
    freq: 9, valueWindow: 547_000_000,
    netInflowWindow: 545_300_000,
    avgMfWindow: 13_900_000,
    smartMoneyTotal: 1_430_000_000,
    badMoneyTotal: 3_700_000,
    triggerCount: 2, isLiquid: true,
    timestamp: new Date()
  });

  // Tunggu semua pesan selesai
  log.info('⏳ Menunggu semua pesan terkirim (±30 detik)...');
  await new Promise(resolve => setTimeout(resolve, 30000));

  const stats = notifier.getStats();
  log.info(`📊 Hasil: Terkirim=${stats.totalSent} | Error=${stats.totalErrors} | Blocked=${stats.totalBlocked}`);

  if (stats.totalSent === 9 && stats.totalErrors === 0) {
    log.info('✅ SEMUA 9 ALERT BERHASIL TERKIRIM!');
  } else {
    log.error('❌ Ada yang gagal. Periksa konfigurasi .env Anda.');
  }

  process.exit(0);
}

runTest();
