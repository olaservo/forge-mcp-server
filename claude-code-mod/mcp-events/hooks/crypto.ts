/**
 * HMAC-SHA256 and HPKE with what a hooks module has: `crypto.subtle.digest`, `crypto.getRandomValues` and BigInt.
 * There is no `sign`, `deriveBits` or `decrypt`, so X25519 and AES-128-GCM are done here. The arithmetic does not
 * run in constant time.
 *
 * HPKE is RFC 9180 base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM, one message per context:
 * the scheme `hpke-x25519-sha256-aes128gcm` of `src/hpke.ts`. `test/mod-crypto.test.ts` checks it against the CFRG
 * test vectors and against that file.
 */

const encoder = new TextEncoder()

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))

/** HMAC-SHA256 (RFC 2104). */
export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? await sha256(key) : key)
  const inner = await sha256(concat(block.map(b => b ^ 0x36), message))
  return sha256(concat(block.map(b => b ^ 0x5c), inner))
}

// X25519 (RFC 7748)

const P = 2n ** 255n - 19n
const mod = (n: bigint) => ((n % P) + P) % P

function power(base: bigint, exponent: bigint): bigint {
  let out = 1n
  for (let b = base, e = exponent; e > 0n; e >>= 1n, b = mod(b * b)) if (e & 1n) out = mod(out * b)
  return out
}

function fromLittleEndian(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i] ?? 0)
  return n
}

/** The u-coordinate of `scalar` times the point with u-coordinate `u`. Both are 32 bytes. */
export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  if (scalar.length !== 32 || u.length !== 32) throw new Error('an X25519 key is 32 bytes')
  const k = (fromLittleEndian(scalar) & ~7n & ((1n << 255n) - 1n)) | (1n << 254n)
  const x1 = mod(fromLittleEndian(u) & ((1n << 255n) - 1n))
  let [x2, z2, x3, z3] = [1n, 0n, x1, 1n]
  let swap = 0n
  for (let t = 254n; t >= 0n; t--) {
    const bit = (k >> t) & 1n
    if (swap ^ bit) [x2, z2, x3, z3] = [x3, z3, x2, z2]
    swap = bit
    const a = mod(x2 + z2)
    const b = mod(x2 - z2)
    const aa = mod(a * a)
    const bb = mod(b * b)
    const e = mod(aa - bb)
    const da = mod((x3 - z3) * a)
    const cb = mod((x3 + z3) * b)
    x3 = mod((da + cb) ** 2n)
    z3 = mod(x1 * (da - cb) ** 2n)
    x2 = mod(aa * bb)
    z2 = mod(e * (aa + 121665n * e))
  }
  if (swap) [x2, z2] = [x3, z3]
  let out = mod(x2 * power(z2, P - 2n))
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++, out >>= 8n) bytes[i] = Number(out & 0xffn)
  return bytes
}

const BASE_POINT = new Uint8Array(32).fill(9, 0, 1)

/** The public key of a 32-byte X25519 private key. */
export const publicKey = (privateKey: Uint8Array): Uint8Array => x25519(privateKey, BASE_POINT)

// AES-128 (FIPS 197), encryption only: GCM uses the block cipher in one direction.

const SBOX = new Uint8Array(256)
{
  // The inverse in GF(2^8), then the affine transform. `p` runs through the powers of 3 and `q` through their inverses.
  let p = 1
  let q = 1
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0)) & 0xff
    q ^= q << 1
    q ^= q << 2
    q ^= q << 4
    q &= 0xff
    if (q & 0x80) q ^= 0x09
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
    SBOX[p] = (x ^ 0x63) & 0xff
  } while (p !== 1)
  SBOX[0] = 0x63
}

const xtime = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff

/** The 11 round keys of a 16-byte key, as 176 bytes. */
function roundKeys(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error('an AES-128 key is 16 bytes')
  const w = new Uint8Array(176)
  w.set(key)
  for (let i = 16, rcon = 1; i < 176; i += 4) {
    let t = [w[i - 4]!, w[i - 3]!, w[i - 2]!, w[i - 1]!]
    if (i % 16 === 0) {
      t = [SBOX[t[1]!]! ^ rcon, SBOX[t[2]!]!, SBOX[t[3]!]!, SBOX[t[0]!]!]
      rcon = xtime(rcon)
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i + j - 16]! ^ t[j]!
  }
  return w
}

function encryptBlock(w: Uint8Array, block: Uint8Array): Uint8Array {
  let s = block.map((b, i) => b ^ w[i]!)
  for (let round = 1; round <= 10; round++) {
    const t = new Uint8Array(16)
    // SubBytes and ShiftRows: row r of column c comes from column c + r.
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[4 * c + r] = SBOX[s[4 * ((c + r) % 4) + r]!]!
    if (round < 10) {
      for (let c = 0; c < 16; c += 4) {
        const [a0, a1, a2, a3] = [t[c]!, t[c + 1]!, t[c + 2]!, t[c + 3]!]
        const all = a0 ^ a1 ^ a2 ^ a3
        t[c] = a0 ^ all ^ xtime(a0 ^ a1)
        t[c + 1] = a1 ^ all ^ xtime(a1 ^ a2)
        t[c + 2] = a2 ^ all ^ xtime(a2 ^ a3)
        t[c + 3] = a3 ^ all ^ xtime(a3 ^ a0)
      }
    }
    s = t.map((b, i) => b ^ w[16 * round + i]!)
  }
  return s
}

// GCM (NIST SP 800-38D) with a 12-byte nonce and a 16-byte tag.

const TAG_LENGTH = 16
const REDUCTION = 0xe1n << 120n

function fromBigEndian(bytes: Uint8Array): bigint {
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  return n
}

/** GHASH of `data`, a whole number of blocks, under the hash key `h`. */
function ghash(h: bigint, data: Uint8Array): bigint {
  // powers[i] is h times x^i, so a block times h is the XOR of the powers at the block's set bits.
  const powers = [h]
  for (let i = 1; i < 128; i++) {
    const v = powers[i - 1]!
    powers.push(v & 1n ? (v >> 1n) ^ REDUCTION : v >> 1n)
  }
  const y = new Uint8Array(16)
  for (let at = 0; at < data.length; at += 16) {
    let z = 0n
    for (let i = 0; i < 16; i++) {
      const byte = y[i]! ^ data[at + i]!
      for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) z ^= powers[8 * i + bit]!
    }
    for (let i = 15; i >= 0; i--, z >>= 8n) y[i] = Number(z & 0xffn)
  }
  return fromBigEndian(y)
}

const padded = (bytes: Uint8Array) => concat(bytes, new Uint8Array((16 - (bytes.length % 16)) % 16))

function lengths(aad: Uint8Array, text: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  const view = new DataView(out.buffer)
  view.setBigUint64(0, BigInt(aad.length) * 8n)
  view.setBigUint64(8, BigInt(text.length) * 8n)
  return out
}

/** Counter mode from block 2 of the nonce, which encrypts and decrypts, and the tag over `aad` and the ciphertext. */
function gcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, input: Uint8Array, isSealed: boolean): { output: Uint8Array; tag: Uint8Array } {
  if (nonce.length !== 12) throw new Error('a GCM nonce is 12 bytes')
  const w = roundKeys(key)
  const counter = concat(nonce, new Uint8Array(4))
  const view = new DataView(counter.buffer)
  const output = new Uint8Array(input.length)
  for (let at = 0, n = 2; at < input.length; at += 16, n++) {
    view.setUint32(12, n)
    const pad = encryptBlock(w, counter)
    for (let i = at; i < Math.min(at + 16, input.length); i++) output[i] = input[i]! ^ pad[i - at]!
  }
  const ciphertext = isSealed ? input : output
  const hash = ghash(fromBigEndian(encryptBlock(w, new Uint8Array(16))), concat(padded(aad), padded(ciphertext), lengths(aad, ciphertext)))
  view.setUint32(12, 1)
  const tag = encryptBlock(w, counter)
  for (let i = 15, h = hash; i >= 0; i--, h >>= 8n) tag[i] = tag[i]! ^ Number(h & 0xffn)
  return { output, tag }
}

// HPKE (RFC 9180)

const i2osp = (n: number, length: number) => Uint8Array.from({ length }, (_, i) => Math.floor(n / 256 ** (length - 1 - i)) % 256)
const VERSION = encoder.encode('HPKE-v1')
const EMPTY = new Uint8Array(0)
const KEM_SUITE = concat(encoder.encode('KEM'), i2osp(0x0020, 2))
const HPKE_SUITE = concat(encoder.encode('HPKE'), i2osp(0x0020, 2), i2osp(0x0001, 2), i2osp(0x0001, 2))

const extract = (salt: Uint8Array, ikm: Uint8Array) => hmacSha256(salt.length > 0 ? salt : new Uint8Array(32), ikm)

async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  let block: Uint8Array = EMPTY
  let out: Uint8Array = EMPTY
  for (let i = 1; out.length < length; i++) {
    block = await hmacSha256(prk, concat(block, info, Uint8Array.of(i)))
    out = concat(out, block)
  }
  return out.subarray(0, length)
}

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(salt, concat(VERSION, suite, encoder.encode(label), ikm))
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) =>
  expand(prk, concat(i2osp(length, 2), VERSION, suite, encoder.encode(label), info), length)

/** The AEAD key and nonce of a base-mode context, from the Diffie-Hellman result. */
async function schedule(dh: Uint8Array, enc: Uint8Array, pkR: Uint8Array, info: Uint8Array): Promise<{ key: Uint8Array; nonce: Uint8Array }> {
  if (dh.every(byte => byte === 0)) throw new Error('the shared point is zero')
  const shared = await labeledExpand(KEM_SUITE, await labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh), 'shared_secret', concat(enc, pkR), 32)
  const context = concat(Uint8Array.of(0), await labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY), await labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info))
  const secret = await labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY)
  return { key: await labeledExpand(HPKE_SUITE, secret, 'key', context, 16), nonce: await labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, 12) }
}

/** The plaintext of a single-shot seal to `privateKey`. Throws when `enc`, `info`, `aad` or the ciphertext is not what was sealed. */
export async function open(privateKey: Uint8Array, enc: Uint8Array, info: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < TAG_LENGTH) throw new Error('the ciphertext is shorter than its tag')
  const { key, nonce } = await schedule(x25519(privateKey, enc), enc, publicKey(privateKey), info)
  const { output, tag } = gcm(key, nonce, aad, sealed.subarray(0, -TAG_LENGTH), true)
  let diff = 0
  for (let i = 0; i < TAG_LENGTH; i++) diff |= tag[i]! ^ sealed[sealed.length - TAG_LENGTH + i]!
  if (diff !== 0) throw new Error('the ciphertext does not open')
  return output
}

/** A single-shot seal to the public key `pkR`, for the tests. `ephemeral` is for test vectors. */
export async function seal(pkR: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, ephemeral = crypto.getRandomValues(new Uint8Array(32))): Promise<{ enc: Uint8Array; ct: Uint8Array }> {
  const enc = publicKey(ephemeral)
  const { key, nonce } = await schedule(x25519(ephemeral, pkR), enc, pkR, info)
  const { output, tag } = gcm(key, nonce, aad, plaintext, false)
  return { enc, ct: concat(output, tag) }
}
