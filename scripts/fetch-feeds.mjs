// Fetches Dutch-language Reddit posts and free news feeds, and writes feeds.json next to index.html.
// Runs in GitHub Actions (see .github/workflows/deploy.yml); no dependencies.
import { writeFile } from "node:fs/promises";

// Kept to calm hobby subreddits: no politics or general news subs.
// Quiet subreddits use a longer period so there is enough to read.
const FEEDS = [
  { name: "Tuin", subs: "tuinieren+moestuin", period: "month" },
  { name: "Kamerplanten", subs: "kamerplanten", period: "month" },
  { name: "Huis", subs: "Klussers", period: "week" },
  { name: "Koken", subs: "koken", period: "month" },
  // News sites without a paywall.
  { name: "VRT NWS", url: "https://www.vrt.be/vrtnws/nl.rss.articles.xml" },
  { name: "TVL", url: "https://www.tvl.be/rss" },
];
const PER_FEED = 8;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Anonymous Reddit allows about one request a minute, so wait out a 429 and retry.
async function fetchReddit(feed) {
  const url = `https://www.reddit.com/r/${feed.subs}/top/.rss?t=${feed.period}&limit=25`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return res.text();
    if (res.status !== 429 || attempt === 4) throw new Error(`HTTP ${res.status}`);
    const wait = (+res.headers.get("x-ratelimit-reset") || 60) + 2;
    console.log(`${feed.name}: rate limited, waiting ${wait}s`);
    await sleep(wait * 1000);
  }
}

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
    // Keep Reddit's "top" order; sort news by date.
    let items;
    if (feed.subs) {
      items = parse(await fetchReddit(feed));
    } else {
      const res = await fetch(feed.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = parse(await res.text()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    }
    items = items.slice(0, PER_FEED);
    result.feeds.push({ name: feed.name, items });
    console.log(`${feed.name}: ${items.length} items`);
  } catch (err) {
    console.error(`${feed.name}: ${err.message}`);
    result.feeds.push({ name: feed.name, items: [] });
  }
}

await writeFile(new URL("../feeds.json", import.meta.url), JSON.stringify(result, null, 1));
