import { z } from "zod";
import { fetchNames, NAME_TYPES, type GetText } from "../names.js";
import * as out from "../schemas.js";
import { run, type RegisterTool } from "./common.js";

export function registerNameTools(tool: RegisterTool, get?: GetText): void {
  tool(
    "forge_name_ideas",
    {
      title: "Suggest fantasy names",
      description:
        "A few generated fantasy names to choose a seat name from, fetched from donjon's name generator (donjon.bin.sh). " +
        "Pick one that suits your character or deck and set it with forge_lobby_name. Call it once per naming; if it fails, make up a name. " +
        `\`type\` is the kind of name: ${NAME_TYPES.join(", ")}. The four after the elementals give longer titles.`,
      inputSchema: z.object({
        type: z.string().trim().min(1).max(40).default("Wizard"),
        count: z.number().int().min(1).max(10).default(5),
      }),
      outputSchema: out.Names,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ type, count }) => run(() => fetchNames(type, count, get)),
  );
}
