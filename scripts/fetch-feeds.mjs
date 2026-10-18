// Fetches the news feeds and writes feeds.json next to index.html.
// Runs in GitHub Actions (see .github/workflows/deploy.yml); no dependencies.
import { writeFile } from "node:fs/promises";

const FEEDS = [
  { name: "VRT NWS", url: "https://www.vrt.be/vrtnws/nl.rss.articles.xml" },
  { name: "HLN", url: "https://www.hln.be/home/rss.xml" },
  { name: "HBVL", url: "https://www.hbvl.be/rss/" },
  { name: "TVL", url: "https://www.tvl.be/rss" },
];
const PER_FEED = 6;

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};
const attr = (xml, pattern, name) => {
  const el = xml.match(pattern);
  const m = el && el[0].match(new RegExp(`${name}="([^"]+)"`));
  return m ? decode(m[1]) : "";
};

function parse(xml) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map(b => {
    const link = tag(b, "link") || attr(b, /<link[^>]*rel="alternate"[^>]*>/i, "href") || attr(b, /<link[^>]*>/i, "href");
    const image =
      attr(b, /<enclosure[^>]*type="image[^>]*>/i, "url") ||
      attr(b, /<media:(content|thumbnail)[^>]*>/i, "url") ||
      attr(b, /<link[^>]*rel="enclosure"[^>]*>/i, "href");
    const date = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published");
    return {
      title: tag(b, "title"),
      link,
      image,
      date: date ? new Date(date).toISOString() : null,
    };
  }).filter(i => i.title && i.link);
}

const result = { updated: new Date().toISOString(), feeds: [] };
for (const feed of FEEDS) {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 (omiestart)" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parse(await res.text())
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, PER_FEED);
    result.feeds.push({ name: feed.name, items });
    console.log(`${feed.name}: ${items.length} items`);
  } catch (err) {
    console.error(`${feed.name}: ${err.message}`);
    result.feeds.push({ name: feed.name, items: [] });
  }
}

await writeFile(new URL("../feeds.json", import.meta.url), JSON.stringify(result, null, 1));
