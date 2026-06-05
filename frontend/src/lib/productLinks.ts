/**
 * Quick-commerce purchase links.
 *
 * We can't get stable per-SKU deep links for arbitrary foods/supplements, so we
 * build search URLs for each store — these reliably land the user on a purchase
 * page for the queried product on Amazon, Blinkit, and Zepto.
 */

export interface StoreLink {
  store: string;
  url: string;
  short: string; // compact label for chips
}

const enc = encodeURIComponent;

export function productLinks(query: string): StoreLink[] {
  const q = query.trim();
  if (!q) return [];
  return [
    { store: "Amazon", short: "Amazon", url: `https://www.amazon.in/s?k=${enc(q)}` },
    { store: "Blinkit", short: "Blinkit", url: `https://blinkit.com/s/?q=${enc(q)}` },
    { store: "Zepto", short: "Zepto", url: `https://www.zeptonow.com/search?query=${enc(q)}` },
  ];
}

/** Build one combined search query from a list of foods (caps length). */
export function combinedQuery(items: string[], max = 5): string {
  return items
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
    .join(" ");
}
