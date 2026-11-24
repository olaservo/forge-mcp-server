import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type CipherGCMTypes, type KeyObject } from "node:crypto";

// RFC 9180 base mode with DHKEM(X25519, HKDF-SHA256) and HKDF-SHA256, from Node built-ins.
// The same file as `src/reader/hpke.ts` in olaservo/mcp-mailbox. `test/fixtures/hpke-vectors.json` holds the CFRG test vectors it is checked against.

/** RFC 9180 AEAD ids: AES-128-GCM, AES-256-GCM and ChaCha20-Poly1305. */
export type AeadId = 1 | 2 | 3;
export interface Context {
  key: Buffer;
  baseNonce: Buffer;
}

const cat = (...parts: (Uint8Array | number[])[]) => Buffer.concat(parts.map((part) => Buffer.from(part)));
/** `n` as `length` bytes, big-endian. */
const i2osp = (n: number, length: number) => {
  const out = Buffer.alloc(length);
  for (let i = length - 1; n > 0; i--, n = Math.floor(n / 256)) out[i] = n % 256;
  return out;
};
const EMPTY = Buffer.alloc(0);
const VERSION = Buffer.from("HPKE-v1");

const extract = (salt: Buffer, ikm: Buffer) => createHmac("sha256", salt.length > 0 ? salt : Buffer.alloc(32)).update(ikm).digest();
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  let block: Buffer = EMPTY;
  let out: Buffer = EMPTY;
  for (let i = 1; out.length < length; i++) {
    block = createHmac("sha256", prk).update(cat(block, info, [i])).digest();
    out = cat(out, block);
  }
  return out.subarray(0, length);
}
const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) => extract(salt, cat(VERSION, suite, Buffer.from(label), ikm));
const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) => expand(prk, cat(i2osp(length, 2), VERSION, suite, Buffer.from(label), info), length);

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEADS = { 1: { name: "aes-128-gcm", keyLength: 16 }, 2: { name: "aes-256-gcm", keyLength: 32 }, 3: { name: "chacha20-poly1305", keyLength: 32 } } as const;
const TAG_LENGTH = 16;
const KEM_SUITE = cat(Buffer.from("KEM"), i2osp(KEM_ID, 2));

// The DER that precedes a raw X25519 key in PKCS#8 and in SPKI.
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
export const privFromRaw = (sk: Buffer) => createPrivateKey({ key: cat(PKCS8, sk), format: "der", type: "pkcs8" });
export function pubFromRaw(pk: Buffer): KeyObject {
  if (pk.length !== 32) throw new Error("an X25519 public key is 32 bytes");
  return createPublicKey({ key: cat(SPKI, pk), format: "der", type: "spki" });
}
export const rawPub = (key: KeyObject) => createPublicKey(key).export({ format: "der", type: "spki" }).subarray(SPKI.length);

function sharedSecret(dh: Buffer, enc: Buffer, pkR: Buffer): Buffer {
  const prk = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", cat(enc, pkR), 32);
}

function schedule(aead: AeadId, secret: Buffer, info: Buffer): Context {
  const suite = cat(Buffer.from("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(aead, 2));
  const pskIdHash = labeledExtract(suite, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(suite, EMPTY, "info_hash", info);
  const context = cat([0], pskIdHash, infoHash);
  const prk = labeledExtract(suite, secret, "secret", EMPTY);
  return { key: labeledExpand(suite, prk, "key", context, AEADS[aead].keyLength), baseNonce: labeledExpand(suite, prk, "base_nonce", context, 12) };
}

const nonceFor = (base: Buffer, seq: number) => {
  const counter = i2osp(seq, 12);
  return Buffer.from(base.map((byte, i) => byte ^ counter[i]!));
};

// The three ciphers take the same calls. The cast picks the overload that has them.
const cipherName = (aead: AeadId) => AEADS[aead].name as CipherGCMTypes;

/** The sender's half. `ephemeral` is for test vectors. */
export function setupS(aead: AeadId, pkR: Buffer, info: Buffer, ephemeral?: { privateKey: KeyObject }): Context & { enc: Buffer } {
  const { privateKey } = ephemeral ?? generateKeyPairSync("x25519");
  const enc = rawPub(privateKey);
  const dh = diffieHellman({ privateKey, publicKey: pubFromRaw(pkR) });
  return { enc, ...schedule(aead, sharedSecret(dh, enc, pkR), info) };
}

/** The receiver's half. Throws when `enc` is not a public key. */
export function setupR(aead: AeadId, enc: Buffer, skR: KeyObject, info: Buffer): Context {
  const dh = diffieHellman({ privateKey: skR, publicKey: pubFromRaw(enc) });
  return schedule(aead, sharedSecret(dh, enc, rawPub(skR)), info);
}

/** The ciphertext with its tag, for message `seq` of a context. */
export function sealSeq(aead: AeadId, context: Context, seq: number, aad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv(cipherName(aead), context.key, nonceFor(context.baseNonce, seq), { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad);
  return cat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
}

/** The plaintext of message `seq`. Throws when the key, nonce, `aad` or ciphertext is not what was sealed. */
export function openSeq(aead: AeadId, context: Context, seq: number, aad: Buffer, sealed: Buffer): Buffer {
  const decipher = createDecipheriv(cipherName(aead), context.key, nonceFor(context.baseNonce, seq), { authTagLength: TAG_LENGTH });
  const tagAt = sealed.length - TAG_LENGTH;
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(tagAt));
  return cat(decipher.update(sealed.subarray(0, tagAt)), decipher.final());
}
