import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";

/** Forge's avatar sheet is a grid of 100 px tiles. */
const TILE = 100;
const COLUMNS = 6;
const ROWS = 5;
const LABEL = 16;
const SCALE = 2;
export const AVATARS_PER_PAGE = COLUMNS * ROWS;

/** 3x5 digits, one row per string. */
const DIGITS = [
  ["111", "101", "101", "101", "111"],
  ["010", "110", "010", "010", "111"],
  ["111", "001", "111", "100", "111"],
  ["111", "001", "111", "001", "111"],
  ["101", "101", "111", "001", "001"],
  ["111", "100", "111", "001", "111"],
  ["111", "100", "111", "101", "111"],
  ["111", "001", "001", "001", "001"],
  ["111", "101", "111", "101", "111"],
  ["111", "101", "111", "001", "111"],
];

/** `FORGE_AVATARS`, or the default skin's sheet under `FORGE_HOME`. */
export function avatarSheetPath(): string | undefined {
  if (process.env.FORGE_AVATARS) return process.env.FORGE_AVATARS;
  const home = process.env.FORGE_HOME;
  return home ? join(home, "res", "skins", "default", "sprite_avatars.png") : undefined;
}

/**
 * Tile origins in avatar-index order. Follows `FSkin.assembleAvatars`: row by row,
 * skipping the first tile and any tile whose centre pixel is fully transparent.
 */
export function avatarTiles(sheet: PNG): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y + TILE <= sheet.height; y += TILE) {
    for (let x = 0; x + TILE <= sheet.width; x += TILE) {
      if (x === 0 && y === 0) continue;
      const alpha = sheet.data[((y + TILE / 2) * sheet.width + x + TILE / 2) * 4 + 3];
      if (alpha !== 0) tiles.push({ x, y });
    }
  }
  return tiles;
}

function fill(png: PNG, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
      png.data[i + 3] = 255;
    }
  }
}

function label(png: PNG, text: string, x0: number, y0: number): void {
  [...text].forEach((ch, n) => {
    DIGITS[Number(ch)]!.forEach((row, r) => {
      [...row].forEach((bit, c) => {
        if (bit === "1") fill(png, x0 + (n * 4 + c) * SCALE, y0 + r * SCALE, SCALE, SCALE, [255, 255, 255]);
      });
    });
  });
}

export interface AvatarPage {
  png: Buffer;
  count: number;
  page: number;
  pages: number;
  first: number;
  last: number;
}

/** One page of the avatar sheet as a PNG, each tile with its index underneath. */
export async function avatarPage(path: string, page: number): Promise<AvatarPage> {
  const sheet = PNG.sync.read(await readFile(path));
  const tiles = avatarTiles(sheet);
  const pages = Math.max(1, Math.ceil(tiles.length / AVATARS_PER_PAGE));
  if (page >= pages) throw new Error(`page ${page} is past the last page (${pages - 1})`);
  const first = page * AVATARS_PER_PAGE;
  const shown = tiles.slice(first, first + AVATARS_PER_PAGE);
  const rows = Math.max(1, Math.ceil(shown.length / COLUMNS));
  const out = new PNG({ width: COLUMNS * TILE, height: rows * (TILE + LABEL) });
  fill(out, 0, 0, out.width, out.height, [24, 24, 24]);
  shown.forEach((tile, n) => {
    const x = (n % COLUMNS) * TILE;
    const y = Math.floor(n / COLUMNS) * (TILE + LABEL);
    for (let ty = 0; ty < TILE; ty++) {
      for (let tx = 0; tx < TILE; tx++) {
        const src = ((tile.y + ty) * sheet.width + tile.x + tx) * 4;
        if (sheet.data[src + 3] === 0) continue;
        const dst = ((y + ty) * out.width + x + tx) * 4;
        // Five bits a channel: no visible change at this size, and the page is about a third smaller.
        for (let c = 0; c < 3; c++) out.data[dst + c] = sheet.data[src + c]! & 0xf8;
      }
    }
    label(out, String(first + n), x + 4, y + TILE + 3);
  });
  return { png: PNG.sync.write(out, { colorType: 2 }), count: tiles.length, page, pages, first, last: first + shown.length - 1 };
}
