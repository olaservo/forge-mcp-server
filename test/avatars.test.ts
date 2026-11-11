import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { avatarPage, avatarTiles } from "../src/avatars.js";
import { avatarSheet } from "./helpers.js";

describe("avatars", () => {
  it("indexes tiles the way Forge does: row by row, without the first tile and empty tiles", () => {
    const sheet = PNG.sync.read(readFileSync(avatarSheet(3, 2, [[1, 1]])));
    expect(avatarTiles(sheet)).toEqual([
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 0, y: 100 },
      { x: 200, y: 100 },
    ]);
  });

  it("renders a page with the index range it shows", async () => {
    const page = await avatarPage(avatarSheet(10, 6), 1);
    expect(page).toMatchObject({ count: 59, page: 1, pages: 2, first: 30, last: 58 });
    const png = PNG.sync.read(page.png);
    expect([png.width, png.height]).toEqual([600, 5 * 116]);
    await expect(avatarPage(avatarSheet(3, 2), 1)).rejects.toThrow("past the last page");
  });
});
