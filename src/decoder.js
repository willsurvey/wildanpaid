// =============================================================================
// DECODER — Penerjemah Biner Protobuf Stockbit → Objek Javascript
// =============================================================================
// Modul ini menerjemahkan byte array mentah dari WebSocket menjadi
// objek trade yang bisa dibaca manusia. Berdasarkan hasil reverse-engineering
// terhadap 10 Tag Protobuf di pesan Running Trade Stockbit.
//
// Struktur per Transaksi (Tag 1-10):
//   Tag 1  : Timestamp (nested: detik + nanodetik)
//   Tag 2  : Ticker/Simbol (string, misal "MBMA")
//   Tag 3  : Harga (double 64-bit)
//   Tag 4  : Volume/Lot (double 64-bit)
//   Tag 5  : Aksi — 1=BUY (Hajar Kanan), 2=SELL (Hajar Kiri)
//   Tag 6  : Papan Market — 1=Reguler
//   Tag 7  : Timestamp Server (nested)
//   Tag 8  : Change Info (nested: netChange + pctChange)
//   Tag 9  : Trade ID (varint)
//   Tag 10 : Status (varint, selalu 1)
// =============================================================================

const { createLogger } = require('./logger');
const log = createLogger('DECODER');

// ---------------------------------------------------------------------------
// Protobuf Wire Type Constants
// ---------------------------------------------------------------------------
const WIRE_VARINT = 0;           // int32, int64, bool
const WIRE_64BIT = 1;            // double, fixed64
const WIRE_LENGTH_DELIMITED = 2; // string, bytes, nested messages
const WIRE_32BIT = 5;            // float, fixed32

// ---------------------------------------------------------------------------
// Low-level Protobuf Decoders
// ---------------------------------------------------------------------------

/**
 * Decode varint (variable-length integer) dari buffer.
 * @param {Buffer} buf - Buffer sumber
 * @param {number} offset - Posisi mulai baca
 * @returns {{value: number, offset: number}} Nilai dan posisi setelah baca
 */
function decodeVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let byte;

  do {
    if (offset >= buf.length) return { value: result, offset };
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;

    // Proteksi overflow: varint max 10 bytes (64-bit)
    if (shift > 70) {
      log.warn('⚠️ Varint overflow terdeteksi');
      return { value: result, offset };
    }
  } while (byte & 0x80);

  // JavaScript bitwise ops bekerja di 32-bit, jadi kita
  // gunakan unsigned right shift untuk memastikan positif
  return { value: result >>> 0, offset };
}

/**
 * Decode double 64-bit (little-endian) dari buffer.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{value: number, offset: number}}
 */
function decodeDouble(buf, offset) {
  if (offset + 8 > buf.length) return { value: 0, offset };
  const value = buf.readDoubleLE(offset);
  return { value, offset: offset + 8 };
}

/**
 * Decode nested timestamp message: { 1: seconds, 2: nanos }.
 * @param {Buffer} buf
 * @returns {{seconds: number, nanos: number}}
 */
function decodeTimestamp(buf) {
  let offset = 0;
  let seconds = 0;
  let nanos = 0;

  while (offset < buf.length) {
    const tag = buf[offset++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === WIRE_VARINT) {
      const result = decodeVarint(buf, offset);
      offset = result.offset;
      if (fieldNum === 1) seconds = result.value;
      else if (fieldNum === 2) nanos = result.value;
    } else {
      break; // Unknown wire type di timestamp, keluar
    }
  }

  return { seconds, nanos };
}

/**
 * Decode nested change info: { 1: netChange (double), 2: pctChange (double) }.
 * @param {Buffer} buf
 * @returns {{netChange: number, pctChange: number}}
 */
function decodeChangeInfo(buf) {
  let offset = 0;
  let netChange = 0;
  let pctChange = 0;

  while (offset < buf.length) {
    if (offset >= buf.length) break;
    const tag = buf[offset++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === WIRE_64BIT) {
      const result = decodeDouble(buf, offset);
      offset = result.offset;
      if (fieldNum === 1) netChange = result.value;
      else if (fieldNum === 2) pctChange = result.value;
    } else if (wireType === WIRE_VARINT) {
      const result = decodeVarint(buf, offset);
      offset = result.offset;
    } else {
      break;
    }
  }

  return { netChange, pctChange };
}

// ---------------------------------------------------------------------------
// Trade Parser — Satu Transaksi (Tag 1-10)
// ---------------------------------------------------------------------------

/**
 * Parse satu transaksi dari buffer Protobuf.
 * @param {Buffer} buf - Buffer berisi data satu transaksi
 * @returns {Object} Objek trade yang sudah terdekode
 */
function parseOneTrade(buf) {
  let offset = 0;
  const trade = {
    timestamp: null,      // Date object
    symbol: '',           // Kode saham
    price: 0,             // Harga (Rupiah)
    lot: 0,               // Jumlah lot
    action: 0,            // 1=BUY, 2=SELL
    actionLabel: '',      // 'BUY' atau 'SELL'
    market: 0,            // 1=Reguler
    serverTime: null,     // Date object
    netChange: 0,         // Perubahan harga (poin)
    pctChange: 0,         // Perubahan harga (%)
    tradeId: 0,           // ID transaksi unik
    status: 0,            // Status (biasanya 1)
    value: 0,             // Nilai transaksi = price × lot × 100 (Rupiah)
  };

  while (offset < buf.length) {
    if (offset >= buf.length) break;

    const tagByte = buf[offset++];
    const fieldNum = tagByte >> 3;
    const wireType = tagByte & 0x07;

    switch (wireType) {
      case WIRE_VARINT: {
        const result = decodeVarint(buf, offset);
        offset = result.offset;

        if (fieldNum === 5) {
          trade.action = result.value;
          trade.actionLabel = result.value === 1 ? 'BUY' : 'SELL';
        } else if (fieldNum === 6) {
          trade.market = result.value;
        } else if (fieldNum === 9) {
          trade.tradeId = result.value;
        } else if (fieldNum === 10) {
          trade.status = result.value;
        }
        break;
      }

      case WIRE_64BIT: {
        const result = decodeDouble(buf, offset);
        offset = result.offset;

        if (fieldNum === 3) trade.price = result.value;
        else if (fieldNum === 4) trade.lot = result.value;
        break;
      }

      case WIRE_LENGTH_DELIMITED: {
        const lenResult = decodeVarint(buf, offset);
        offset = lenResult.offset;
        const length = lenResult.value;
        const chunk = buf.subarray(offset, offset + length);
        offset += length;

        if (fieldNum === 1) {
          // Timestamp transaksi
          const ts = decodeTimestamp(chunk);
          trade.timestamp = new Date(ts.seconds * 1000);
        } else if (fieldNum === 2) {
          // Ticker/simbol saham
          trade.symbol = chunk.toString('utf-8');
        } else if (fieldNum === 7) {
          // Timestamp server
          const ts = decodeTimestamp(chunk);
          trade.serverTime = new Date(ts.seconds * 1000);
        } else if (fieldNum === 8) {
          // Change info (netChange + pctChange)
          const info = decodeChangeInfo(chunk);
          trade.netChange = info.netChange;
          trade.pctChange = info.pctChange;
        }
        break;
      }

      case WIRE_32BIT: {
        offset += 4; // Skip 32-bit fixed (tidak dipakai)
        break;
      }

      default: {
        // Wire type tidak dikenal, berhenti parsing
        log.debug(`Unknown wire type ${wireType} at field ${fieldNum}`);
        return trade;
      }
    }
  }

  // Hitung nilai transaksi dalam Rupiah (1 lot = 100 lembar)
  trade.value = trade.price * trade.lot * 100;

  return trade;
}

// ---------------------------------------------------------------------------
// Batch Parser — Membongkar Seluruh Pesan WebSocket
// ---------------------------------------------------------------------------

/**
 * Decode seluruh pesan biner dari WebSocket.
 * Mendeteksi tipe pesan berdasarkan field number di level paling luar.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} rawData - Data mentah dari WebSocket
 * @returns {{type: string, trades?: Array, raw?: Buffer}}
 *   - type: 'runningTrade' | 'ping' | 'error' | 'unknown'
 *   - trades: Array of trade objects (jika type === 'runningTrade')
 */
function decodeMessage(rawData) {
  // Normalisasi input ke Buffer
  let buf;
  if (rawData instanceof ArrayBuffer) {
    buf = Buffer.from(rawData);
  } else if (rawData instanceof Uint8Array) {
    buf = Buffer.from(rawData);
  } else if (Buffer.isBuffer(rawData)) {
    buf = rawData;
  } else {
    log.warn('⚠️ Data format tidak dikenal');
    return { type: 'unknown' };
  }

  if (buf.length === 0) return { type: 'unknown' };

  // Baca tag level paling luar
  let offset = 0;
  const outerTag = buf[offset++];
  const outerField = outerTag >> 3;
  const outerWire = outerTag & 0x07;

  // --- Running Trade Batch (Field 8, Wire Type 2) ---
  if (outerField === 8 && outerWire === WIRE_LENGTH_DELIMITED) {
    const lenResult = decodeVarint(buf, offset);
    offset = lenResult.offset;
    const batchBuf = buf.subarray(offset, offset + lenResult.value);

    const trades = [];
    let innerOffset = 0;

    while (innerOffset < batchBuf.length) {
      if (innerOffset >= batchBuf.length) break;

      const innerTag = batchBuf[innerOffset++];
      const innerField = innerTag >> 3;
      const innerWire = innerTag & 0x07;

      if (innerField === 1 && innerWire === WIRE_LENGTH_DELIMITED) {
        // Setiap trade adalah Tag 1 (length-delimited) di dalam batch
        const tradeLenResult = decodeVarint(batchBuf, innerOffset);
        innerOffset = tradeLenResult.offset;
        const tradeLen = tradeLenResult.value;
        const tradeBuf = batchBuf.subarray(innerOffset, innerOffset + tradeLen);
        innerOffset += tradeLen;

        try {
          const trade = parseOneTrade(tradeBuf);
          if (trade.symbol) trades.push(trade);
        } catch (err) {
          log.debug(`⚠️ Gagal parse trade: ${err.message}`);
        }
      } else {
        // Skip field yang tidak dikenal
        if (innerWire === WIRE_LENGTH_DELIMITED) {
          const skipLen = decodeVarint(batchBuf, innerOffset);
          innerOffset = skipLen.offset + skipLen.value;
        } else if (innerWire === WIRE_VARINT) {
          const skipVar = decodeVarint(batchBuf, innerOffset);
          innerOffset = skipVar.offset;
        } else if (innerWire === WIRE_64BIT) {
          innerOffset += 8;
        } else if (innerWire === WIRE_32BIT) {
          innerOffset += 4;
        } else {
          break;
        }
      }
    }

    return { type: 'runningTrade', trades };
  }

  // --- Pesan lain (Ping, Error, LivePrice, dll.) ---
  // Untuk saat ini, kita log dan kembalikan sebagai 'unknown'
  // Nanti bisa diperluas jika perlu
  return { type: 'unknown', fieldNumber: outerField, raw: buf };
}

module.exports = { decodeMessage, parseOneTrade, decodeVarint };
