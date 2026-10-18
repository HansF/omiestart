// Fetches Dutch-language Reddit posts, YouTube videos, SeniorenNet forum posts
// and free news feeds, and writes feeds.json next to index.html.
// Runs in GitHub Actions (see .github/workflows/deploy.yml); no dependencies.
import { writeFile } from "node:fs/promises";

// Calm Dutch-language hobby subreddits: no politics or general news subs.
// Busy subreddits are fetched separately so they don't crowd out the quiet ones,
// which use a longer period so there is enough to read.
const REDDIT = [
  { subs: "katten+Klussers+GroeneVingers", period: "week" },
  // English, but mostly pictures.
  { subs: "Eyebleach+Jigsawpuzzles+OldPhotosInRealLife", period: "week" },
  { subs: "tuinieren+moestuin+kamerplanten+koken+handwerken+zuinig+wandelen+boeken", period: "month" },
];
const PER_SUB = 3;
// YouTube channel ids (each channel's RSS feed holds its latest 15 videos).
const YOUTUBE = [
  "UCYeCOBt1dH21Z_iF_MeAqxg", // VRT Heimwee
  "UC9VVF4DNqXVxZHmof0S8wmA", // Moesmeisje
  "UCamND7C4hOfrMdzc4r_AGgQ", // Stadstuinieren
  "UCduzI04kaKSiiOo_5Ddrq7g", // Omroep MAX
  "UCLgF_LhuA5c26UdU51Pel5Q", // Verzonken Glorie
  "UCgxM87t7JZF60Z37CQbMaYA", // De Ideale Wereld
  "UC59gT3bFTFNSqafRcluDIsQ", // VRT NWS
  "UCwcX23XtfaXF9h7NfirP7mg", // TV Limburg België
  "UCR9sKFsvZP2UoGNyBExsZCg", // Onroerend Erfgoed
  "UCB0gz41oH3LOmGIX1EODvCA", // VRT MAX
];
const PER_CHANNEL = 3;
// Calm SeniorenNet subforums (no politics or news), as phpBB forum ids.
const SENIORENNET = [
  1, // Seniorennet Café
  32, // Tuin, vijver & groen
  17, // Eten en drinken
  13, // Gezonde levenswijze
  24, // Cultuur en historie
  62, // Plaatjesmagazijn en fotoalbums
  47, // Poëzie en proza
  44, // Columns & kolder
  30, // Wonen & Zorg
];
const FORUM_TOPICS = 12;
const FEEDS = [
  { name: "Reddit", reddit: REDDIT },
  { name: "Video's", youtube: YOUTUBE },
  { name: "SeniorenNet", forums: SENIORENNET },
  // News sites without a paywall.
  { name: "VRT NWS", url: "https://www.vrt.be/vrtnws/nl.rss.articles.xml" },
  { name: "TVL", url: "https://www.tvl.be/rss" },
];
const PER_FEED = 8;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Anonymous Reddit allows about one request a minute, so wait out a 429 and retry.
async function fetchReddit({ subs, period }) {
  const url = `https://www.reddit.com/r/${subs}/top/.rss?t=${period}&limit=100`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return res.text();
    if (res.status !== 429 || attempt === 4) throw new Error(`HTTP ${res.status}`);
    const wait = (+res.headers.get("x-ratelimit-reset") || 60) + 2;
    console.log(`${subs}: rate limited, waiting ${wait}s`);
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
      category: attr(b, /<category[^>]*>/i, "term"),
    };
  }).filter(i => i.title && i.link);
}

const result = { updated: new Date().toISOString(), feeds: [] };
for (const feed of FEEDS) {
  try {
    // Reddit: the top posts of each subreddit, taking turns so every subreddit shows up.
    let items;
    if (feed.reddit) {
      const bySub = new Map();
      for (const group of feed.reddit) {
        // Skip text-only posts: they show up as an empty box.
        for (const item of parse(await fetchReddit(group)).filter(i => i.image)) {
          const list = bySub.get(item.category) || [];
          if (list.length < PER_SUB) list.push({ ...item, source: "r/" + item.category });
          bySub.set(item.category, list);
        }
      }
      items = [];
      for (let i = 0; i < PER_SUB; i++) for (const list of bySub.values()) if (list[i]) items.push(list[i]);
    } else if (feed.youtube) {
      // Newest videos first, skipping Shorts, at most a few per channel.
      items = [];
      for (const id of feed.youtube) {
        const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) { console.error(`YouTube ${id}: HTTP ${res.status}`); continue; }
        const xml = await res.text();
        const channel = tag(xml, "name").split(":")[0]; // "Moesmeisje: tips voor ..." -> "Moesmeisje"
        items.push(...parse(xml)
          .filter(v => !v.link.includes("/shorts/"))
          .slice(0, PER_CHANNEL)
          .map(v => ({ ...v, source: channel, image: `https://i.ytimg.com/vi/${new URL(v.link).searchParams.get("v")}/hqdefault.jpg` })));
      }
      items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    } else if (feed.forums) {
      // Each feed lists the latest posts; keep only the newest post per topic.
      const topics = new Map();
      for (const id of feed.forums) {
        const res = await fetch(`https://www.seniorennet.be/forum/feed/forum/${id}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) { console.error(`SeniorenNet ${id}: HTTP ${res.status}`); continue; }
        for (const b of (await res.text()).match(/<entry>[\s\S]*?<\/entry>/g) || []) {
          const link = attr(b, /<link[^>]*>/i, "href");
          const topic = new URL(link).searchParams.get("t");
          const date = new Date(tag(b, "updated")).toISOString();
          if (topics.has(topic) && topics.get(topic).date >= date) continue;
          // Title is "Forum • Re: Topic"; the post's first picture becomes the thumbnail.
          const [source, title] = tag(b, "title").split(" • ");
          const img = (b.match(/<img src="([^"]+)" class="postimage"/) || [])[1];
          topics.set(topic, { title: title.replace(/^Re: /, ""), link, image: img ? decode(img) : "", date, source });
        }
      }
      items = [...topics.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, FORUM_TOPICS);
    } else {
      const res = await fetch(feed.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = parse(await res.text())
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
        .slice(0, PER_FEED);
    }
    result.feeds.push({ name: feed.name, items });
    console.log(`${feed.name}: ${items.length} items`);
  } catch (err) {
    console.error(`${feed.name}: ${err.message}`);
    result.feeds.push({ name: feed.name, items: [] });
  }
}

await writeFile(new URL("../feeds.json", import.meta.url), JSON.stringify(result, null, 1));
