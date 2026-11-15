/** Fantasy names from donjon's generator (https://donjon.bin.sh/fantasy/name/), which answers a GET with one name per line. */

export type GetText = (url: string) => Promise<string>;

const ENDPOINT = "https://donjon.bin.sh/name/rpc-name.fcgi";

/** Types that answered on 2026-11-14. The generator takes others; an unknown one returns blank lines. */
export const NAME_TYPES = [
  "Wizard",
  ...["Human", "Elvish", "Dwarvish", "Halfling", "Draconic", "Drow", "Orcish", "Norse", "Celtic", "Greek", "Roman", "Egyptian", "Saxon"].flatMap((people) => [
    `${people} Male`,
    `${people} Female`,
  ]),
  "Celestial",
  "Fiendish",
  "Air Elemental",
  "Earth Elemental",
  "Fire Elemental",
  "Water Elemental",
  "Party",
  "Ship",
  "Inn",
  "Deity",
];

const getText: GetText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
};

export async function fetchNames(type: string, count: number, get: GetText = getText): Promise<{ type: string; names: string[]; source: string }> {
  const url = `${ENDPOINT}?${new URLSearchParams({ type, n: String(count) })}`;
  let text: string;
  try {
    text = await get(url);
  } catch (e) {
    throw new Error(`The name generator did not answer (${(e as Error).message}). Make up a name instead.`);
  }
  const names = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  if (names.length === 0) {
    throw new Error(`The name generator has no names of type "${type}". Types that work: ${NAME_TYPES.join(", ")}.`);
  }
  return { type, names, source: "donjon.bin.sh" };
}
