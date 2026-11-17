// Address search that tolerates Ukrainian, Russian or Latin spelling:
// "Ревуцького 54а", "ревуцкого 54а" and "revutskogo 54a" all match.

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i",
  ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e",
  ё: "e", ъ: "",
};

// Street-type words carry no information for matching.
const STOP_WORDS = new Set([
  "vul", "vulytsia", "vulitsa", "ulitsa", "ul", "st", "street", "prosp", "prospekt", "pr", "avenue", "ave",
  "prov", "provulok", "lane", "bulv", "bulvar", "boulevard", "blvd", "pl", "ploshcha", "square", "budynok", "bud",
]);

export function normalize(text: string): string[] {
  const latin = Array.from(text.toLocaleLowerCase("uk"), (ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/g/g, "h") // Russian/English "g" vs Ukrainian "h": revutskogo = revutskoho
    .replace(/[^a-z0-9]+/g, " ");
  return latin.split(" ").filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

export interface Searchable {
  id: number;
  address_uk: string;
  address_en: string;
  slug: string;
}

/** Buildings where every word of the query appears in the address. */
export function searchBuildings<B extends Searchable>(buildings: B[], query: string, limit = 8): B[] {
  const words = normalize(query);
  if (words.length === 0) return [];
  return buildings
    .filter((b) => {
      const hay = normalize(`${b.address_uk} ${b.address_en} ${b.slug}`).join(" ");
      return words.every((w) => hay.includes(w));
    })
    .slice(0, limit);
}
