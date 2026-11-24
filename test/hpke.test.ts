import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AeadId, openSeq, privFromRaw, sealSeq, setupR, setupS } from "../src/hpke.js";

interface Vector {
  aead_id: AeadId;
  info: string;
  skEm: string;
  skRm: string;
  pkRm: string;
  enc: string;
  key: string;
  base_nonce: string;
  encryptions: { seq: number; aad: string; pt: string; ct: string }[];
}

// From test-vectors.json in cfrg/draft-irtf-cfrg-hpke: mode 0, KEM 0x20, KDF 1, and the sequence numbers RFC 9180 prints.
// AEAD 1 and 3 are RFC 9180 A.1.1 and A.2.1.
const vectors = JSON.parse(readFileSync(new URL("./fixtures/hpke-vectors.json", import.meta.url), "utf8")) as Vector[];
const hex = (text: string) => Buffer.from(text, "hex");

describe("HPKE base mode", () => {
  it.each(vectors)("matches the CFRG vector for AEAD $aead_id", (v) => {
    const sender = setupS(v.aead_id, hex(v.pkRm), hex(v.info), { privateKey: privFromRaw(hex(v.skEm)) });
    const receiver = setupR(v.aead_id, hex(v.enc), privFromRaw(hex(v.skRm)), hex(v.info));
    expect(sender.enc.toString("hex")).toBe(v.enc);
    for (const context of [sender, receiver]) {
      expect(context.key.toString("hex")).toBe(v.key);
      expect(context.baseNonce.toString("hex")).toBe(v.base_nonce);
    }
    for (const e of v.encryptions) {
      expect(sealSeq(v.aead_id, sender, e.seq, hex(e.aad), hex(e.pt)).toString("hex")).toBe(e.ct);
      expect(openSeq(v.aead_id, receiver, e.seq, hex(e.aad), hex(e.ct)).toString("hex")).toBe(e.pt);
      expect(() => openSeq(v.aead_id, receiver, e.seq, hex(`${e.aad}00`), hex(e.ct))).toThrow();
    }
    expect(() => setupR(v.aead_id, hex(`${v.enc}00`), privFromRaw(hex(v.skRm)), hex(v.info))).toThrow("32 bytes");
  });
});
