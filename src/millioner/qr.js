'use strict';

/**
 * Pure JavaScript QR Code SVG Generator.
 * Self-contained, zero external dependencies.
 * Generates valid SVG QR codes for URLs and text (ISO/IEC 18004 Byte mode, ECC M).
 */

function createQRCodeSVG(text, { size = 200, margin = 2 } = {}) {
  const EXP_TABLE = new Array(256);
  const LOG_TABLE = new Array(256);
  for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
  for (let i = 8; i < 256; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  }
  for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

  function glog(n) {
    if (n < 1) throw new Error('glog(' + n + ')');
    return LOG_TABLE[n];
  }
  function gexp(n) {
    while (n < 0) n += 255;
    while (n >= 255) n -= 255;
    return EXP_TABLE[n];
  }

  function polyMultiply(p1, p2) {
    const num = new Array(p1.length + p2.length - 1).fill(0);
    for (let i = 0; i < p1.length; i++) {
      for (let j = 0; j < p2.length; j++) {
        num[i + j] ^= gexp(glog(p1[i]) + glog(p2[j]));
      }
    }
    return num;
  }

  function polyMod(p1, p2) {
    const diff = p1.length - p2.length;
    if (diff < 0) return p1;
    const num = p1.slice();
    const ratio = glog(num[0]);
    for (let i = 0; i < p2.length; i++) {
      num[i] ^= gexp(glog(p2[i]) + ratio);
    }
    let firstNonZero = 0;
    while (firstNonZero < num.length && num[firstNonZero] === 0) firstNonZero++;
    return polyMod(num.slice(firstNonZero), p2);
  }

  function getGeneratorPoly(ecLen) {
    let g = [1];
    for (let i = 0; i < ecLen; i++) {
      g = polyMultiply(g, [1, gexp(i)]);
    }
    return g;
  }

  const RS_BLOCK_TABLE = {
    1: { total: 26, data: 16, ec: 10, blocks: [[1, 26, 16]] },
    2: { total: 44, data: 28, ec: 16, blocks: [[1, 44, 28]] },
    3: { total: 70, data: 44, ec: 26, blocks: [[1, 70, 44]] },
    4: { total: 100, data: 64, ec: 36, blocks: [[2, 50, 32]] },
    5: { total: 134, data: 86, ec: 48, blocks: [[2, 67, 43]] },
    6: { total: 172, data: 108, ec: 64, blocks: [[4, 43, 27]] },
    7: { total: 196, data: 124, ec: 72, blocks: [[4, 49, 31]] },
    8: { total: 242, data: 154, ec: 88, blocks: [[2, 61, 39], [2, 62, 40]] },
    9: { total: 292, data: 182, ec: 110, blocks: [[3, 58, 36], [2, 59, 37]] },
    10: { total: 346, data: 216, ec: 130, blocks: [[4, 69, 43], [3, 70, 44]] },
  };

  const ALIGNMENT_PATTERN = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  const utf8Bytes = Buffer.from(String(text || ''), 'utf8');
  let version = 1;
  while (version <= 10) {
    const cap = RS_BLOCK_TABLE[version].data - 3;
    if (utf8Bytes.length <= cap) break;
    version++;
  }
  if (version > 10) version = 10;

  const rsInfo = RS_BLOCK_TABLE[version];
  const dataCapacity = rsInfo.data;

  const bits = [];
  function putBits(num, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((num >>> i) & 1);
  }

  putBits(4, 4); // Byte mode
  putBits(utf8Bytes.length, version >= 10 ? 16 : 8);
  for (const b of utf8Bytes) putBits(b, 8);

  const rem = dataCapacity * 8 - bits.length;
  const term = Math.min(4, Math.max(0, rem));
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < dataCapacity * 8) {
    putBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }

  const totalBlocks = [];
  let offset = 0;
  for (const [numBlocks, totalLen, dataLen] of rsInfo.blocks) {
    const ecLen = totalLen - dataLen;
    const gen = getGeneratorPoly(ecLen);
    for (let b = 0; b < numBlocks; b++) {
      const blockData = dataBytes.slice(offset, offset + dataLen);
      offset += dataLen;
      const padded = blockData.concat(new Array(ecLen).fill(0));
      const mod = polyMod(padded, gen);
      const ecCodewords = new Array(ecLen).fill(0);
      const shift = ecLen - mod.length;
      for (let i = 0; i < mod.length; i++) ecCodewords[i + shift] = mod[i];
      totalBlocks.push({ data: blockData, ec: ecCodewords });
    }
  }

  const finalCodewords = [];
  const maxDataLen = Math.max(...totalBlocks.map((b) => b.data.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const b of totalBlocks) {
      if (i < b.data.length) finalCodewords.push(b.data[i]);
    }
  }
  const maxEcLen = Math.max(...totalBlocks.map((b) => b.ec.length));
  for (let i = 0; i < maxEcLen; i++) {
    for (const b of totalBlocks) {
      if (i < b.ec.length) finalCodewords.push(b.ec[i]);
    }
  }

  const finalBits = [];
  for (const b of finalCodewords) {
    for (let i = 7; i >= 0; i--) finalBits.push((b >>> i) & 1);
  }

  const matrixSize = version * 4 + 17;
  const matrix = Array.from({ length: matrixSize }, () => new Array(matrixSize).fill(null));
  const isReserved = Array.from({ length: matrixSize }, () => new Array(matrixSize).fill(false));

  function setReserved(r, c, val) {
    matrix[r][c] = val;
    isReserved[r][c] = true;
  }

  function placeFinder(r0, c0) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = r0 + r;
        const col = c0 + c;
        if (row < 0 || row >= matrixSize || col < 0 || col >= matrixSize) continue;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          const isBlack = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          setReserved(row, col, isBlack ? 1 : 0);
        } else {
          setReserved(row, col, 0);
        }
      }
    }
  }
  placeFinder(0, 0);
  placeFinder(0, matrixSize - 7);
  placeFinder(matrixSize - 7, 0);

  const alignPos = ALIGNMENT_PATTERN[version] || [];
  for (let i = 0; i < alignPos.length; i++) {
    for (let j = 0; j < alignPos.length; j++) {
      const r = alignPos[i];
      const c = alignPos[j];
      if (isReserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isBlack = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setReserved(r + dr, c + dc, isBlack ? 1 : 0);
        }
      }
    }
  }

  for (let i = 8; i < matrixSize - 8; i++) {
    if (!isReserved[6][i]) setReserved(6, i, i % 2 === 0 ? 1 : 0);
    if (!isReserved[i][6]) setReserved(i, 6, i % 2 === 0 ? 1 : 0);
  }

  setReserved(matrixSize - 8, 8, 1);

  for (let i = 0; i < 9; i++) {
    if (!isReserved[8][i]) isReserved[8][i] = true;
    if (!isReserved[i][8]) isReserved[i][8] = true;
  }
  for (let i = matrixSize - 8; i < matrixSize; i++) {
    if (!isReserved[8][i]) isReserved[8][i] = true;
    if (!isReserved[i][8]) isReserved[i][8] = true;
  }

  let bitIdx = 0;
  let right = matrixSize - 1;
  let upwards = true;

  while (right > 0) {
    if (right === 6) right--;
    const rows = [];
    for (let r = 0; r < matrixSize; r++) rows.push(upwards ? matrixSize - 1 - r : r);
    for (const r of rows) {
      for (let c = right; c >= right - 1; c--) {
        if (isReserved[r][c]) continue;
        const bit = bitIdx < finalBits.length ? finalBits[bitIdx++] : 0;
        const mask = (r + c) % 2 === 0;
        matrix[r][c] = mask ? bit ^ 1 : bit;
      }
    }
    upwards = !upwards;
    right -= 2;
  }

  // Precomputed format bits for ECC M, Mask 0
  const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
  for (let i = 0; i <= 5; i++) matrix[8][i] = formatBits[i];
  matrix[8][7] = formatBits[6];
  matrix[8][8] = formatBits[7];
  matrix[7][8] = formatBits[8];
  for (let i = 9; i <= 14; i++) matrix[14 - i][8] = formatBits[i];
  for (let i = 0; i <= 6; i++) matrix[matrixSize - 1 - i][8] = formatBits[i];
  for (let i = 7; i <= 14; i++) matrix[8][matrixSize - 15 + i] = formatBits[i];

  const totalSize = matrixSize + margin * 2;
  let paths = '';
  for (let r = 0; r < matrixSize; r++) {
    for (let c = 0; c < matrixSize; c++) {
      if (matrix[r][c] === 1) {
        paths += `M${c + margin},${r + margin}h1v1h-1z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <path d="${paths}" fill="#000000"/>
</svg>`;
}

module.exports = { createQRCodeSVG };
