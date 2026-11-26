import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { open, publicKey, seal, x25519 } from "../claude-code-mod/mcp-events/hooks/crypto.js";
import { openSeq, rawPub, sealSeq, setupR, setupS } from "../src/hpke.js";

interface Vector {
  aead_id: number;
  info: string;
  skEm: string;
  skRm: string;
  pkRm: string;
  enc: string;
  encryptions: { seq: number; aad: string; pt: string; ct: string }[];
}

// The mod's HPKE is plain JavaScript, since a hooks module has no X25519 or AES. It has to agree with `src/hpke.ts`,
// which seals what the mod opens.
const vectors = (JSON.parse(readFileSync(new URL("./fixtures/hpke-vectors.json", import.meta.url), "utf8")) as Vector[]).filter((v) => v.aead_id === 1);
const hex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const AES_128_GCM = 1;

describe("the mod's HPKE", () => {
  it("gives the RFC 7748 answer for X25519", () => {
    const scalar = hex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4");
    const u = hex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c");
    expect(toHex(x25519(scalar, u))).toBe("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552");
  });

  it("matches the CFRG vector for AES-128-GCM in both directions", async () => {
    expect(vectors).toHaveLength(1);
    for (const v of vectors) {
      const e = v.encryptions.find((encryption) => encryption.seq === 0)!;
      expect(toHex(publicKey(hex(v.skRm)))).toBe(v.pkRm);
      const sealed = await seal(hex(v.pkRm), hex(v.info), hex(e.aad), hex(e.pt), hex(v.skEm));
      expect(toHex(sealed.enc)).toBe(v.enc);
      expect(toHex(sealed.ct)).toBe(e.ct);
      expect(toHex(await open(hex(v.skRm), hex(v.enc), hex(v.info), hex(e.aad), hex(e.ct)))).toBe(e.pt);
      await expect(open(hex(v.skRm), hex(v.enc), hex(v.info), hex(`${e.aad}00`), hex(e.ct))).rejects.toThrow("does not open");
      await expect(open(hex(v.skRm), hex(v.enc), hex(`${v.info}00`), hex(e.aad), hex(e.ct))).rejects.toThrow("does not open");
      await expect(open(hex(v.skRm), hex(v.enc), hex(v.info), hex(e.aad), hex(e.ct).subarray(0, 8))).rejects.toThrow("shorter than its tag");
    }
  });

  // Lengths on both sides of a 16-byte block, and one of several thousand blocks.
  it.each([0, 1, 15, 16, 17, 31, 32, 33, 255, 4096, 20000])("opens what src/hpke.ts seals, and seals what it opens, for %i bytes", async (size) => {
    const info = Buffer.from(`mcp-events v1 sub_${size}`);
    const aad = Buffer.from(`c-${size}\nforge.your_move\n2026-11-26T00:00:00.000Z`);
    const plaintext = randomBytes(size);

    const privateKey = new Uint8Array(randomBytes(32));
    const sender = setupS(AES_128_GCM, Buffer.from(publicKey(privateKey)), info);
    const fromServer = sealSeq(AES_128_GCM, sender, 0, aad, plaintext);
    expect(Buffer.from(await open(privateKey, sender.enc, info, aad, fromServer)).equals(plaintext)).toBe(true);

    const node = generateKeyPairSync("x25519");
    const fromMod = await seal(rawPub(node.privateKey), info, aad, plaintext);
    const receiver = setupR(AES_128_GCM, Buffer.from(fromMod.enc), node.privateKey, info);
    expect(openSeq(AES_128_GCM, receiver, 0, aad, Buffer.from(fromMod.ct)).equals(plaintext)).toBe(true);
  });
});
