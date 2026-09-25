// Address helpers shared by Crypto Intelligence and the Social report wallet
// screening: SHA-256, base58check, bech32 checksum validation and wallet
// extraction. Checksums prove only that a string is a well-formed address --
// not that it is in use, or who controls it.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONSTANT = 0x2bc830a3;
const TRON_HEX_ADDRESS_RE = /^41[0-9a-fA-F]{40}$/;

function firstPrimes(count) {
  const primes = [];
  for (let n = 2; primes.length < count; n++) {
    if (primes.every(prime => n % prime !== 0)) primes.push(n);
  }
  return primes;
}

// SHA-256 constants are the fractional parts of the cube/square roots of the
// first primes (FIPS 180-4); deriving them avoids a 64-entry hand-typed table.
const fractionBits = value => Math.floor((value - Math.floor(value)) * 4294967296) >>> 0;
const SHA256_K = firstPrimes(64).map(prime => fractionBits(Math.cbrt(prime)));
const SHA256_H0 = firstPrimes(8).map(prime => fractionBits(Math.sqrt(prime)));

// Synchronous SHA-256 (the Workers-native digest is async, and the row builders
// that need base58check are synchronous).
function sha256(bytes) {
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const length = bytes.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 4294967296));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);

  const h = SHA256_H0.slice();
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => { h[i] = (h[i] + value) >>> 0; });
  }
  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  h.forEach((value, i) => out.setUint32(i * 4, value));
  return digest;
}

function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

// Hex ("41...") -> base58check "T..."; anything else is returned unchanged so
// already-base58 addresses (e.g. from the TRC-20 endpoint) pass straight through.
function tronAddress(value) {
  const text = String(value ?? "").trim();
  if (!TRON_HEX_ADDRESS_RE.test(text)) return text;
  const payload = Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(Uint8Array.from([...payload, ...checksum]));
}

// 25-byte base58check payload: 1 version byte + 20-byte hash + 4-byte checksum.
function validBase58Check(value, versions) {
  let number = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) return false;
    number = number * 58n + BigInt(index);
  }
  if (number >= 1n << 200n) return false;
  const raw = new Uint8Array(25);
  for (let i = 24; i >= 0; i--) {
    raw[i] = Number(number & 0xffn);
    number >>= 8n;
  }
  if (!versions.includes(raw[0])) return false;
  const checksum = sha256(sha256(raw.slice(0, 21))).slice(0, 4);
  return checksum.every((byte, i) => byte === raw[21 + i]);
}

function bech32Polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0;
    for (let bit = 0; bit < 5; bit++) {
      if ((top >>> bit) & 1) checksum = (checksum ^ BECH32_GENERATOR[bit]) >>> 0;
    }
  }
  return checksum;
}

function validBitcoinBech32(value) {
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) return false; // mixed case
  const text = value.toLowerCase();
  if (!text.startsWith("bc1") || text.length < 14 || text.length > 90) return false;
  const data = text.slice(3);
  if ([...data].some(char => !BECH32_CHARSET.includes(char))) return false;
  const values = [
    ..."bc".split("").map(char => char.charCodeAt(0) >> 5), 0,
    ..."bc".split("").map(char => char.charCodeAt(0) & 31),
    ...[...data].map(char => BECH32_CHARSET.indexOf(char))
  ];
  const expected = BECH32_CHARSET.indexOf(data[0]) === 0 ? 1 : BECH32M_CONSTANT;
  return bech32Polymod(values) === expected;
}

function isValidWalletAddress(family, address) {
  const value = String(address || "");
  if (family === "evm") return /^0x[a-fA-F0-9]{40}$/.test(value);
  if (family === "tron") return validBase58Check(value, [0x41]);
  if (family === "bitcoin") {
    return /^bc1/i.test(value) ? validBitcoinBech32(value) : validBase58Check(value, [0x00, 0x05]);
  }
  return false;
}

const WALLET_PATTERNS = [
  ["evm", /\b0x[a-fA-F0-9]{40}\b/g],
  ["tron", /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g],
  ["bitcoin", /\bbc1[ac-hj-np-z02-9]{11,71}\b|\bBC1[AC-HJ-NP-Z02-9]{11,71}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g]
];

// Regex candidates filtered by checksum, so random tokens that merely resemble
// an address are not reported as wallets. De-duplicated, first-seen order.
function findWalletCandidates(text) {
  const value = String(text || "");
  const found = [];
  const seen = new Set();
  for (const [family, pattern] of WALLET_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const address = match[0];
      const key = family + ":" + (family === "evm" ? address.toLowerCase() : address);
      if (seen.has(key) || !isValidWalletAddress(family, address)) continue;
      seen.add(key);
      found.push({ family, address });
    }
  }
  return found;
}

export {
  sha256,
  base58Encode,
  tronAddress,
  isValidWalletAddress,
  findWalletCandidates
};
