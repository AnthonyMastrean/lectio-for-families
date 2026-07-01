'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PRAY_URL = 'https://www.24-7prayer.com/lectioforfamilies/pray/';
const FEED_FILE = path.join(__dirname, '..', 'feed.xml');
const FEED_TIMEOUT = 60_000;
const PAGE_SETTLE_TIMEOUT = 5_000;
const DEFAULT_MP3_BITRATE_BPS = 128_000;

/**
 * Parse episode metadata from an MP3 filename or URL path.
 * Handles both historical and current naming schemes:
 *   Week-15-Day-01-Chris.mp3
 *   Y2-WK-51-Day-01-Phil.mp3
 */
function parseEpisodeTitle(url) {
  const filename = decodeURIComponent(url).split('/').pop().replace(/\.mp3(\?.*)?$/i, '');

  // Extract day number (Day-01, Day-02 …)
  const dayMatch = filename.match(/Day[-_]0*(\d+)/i);
  const day = dayMatch ? parseInt(dayMatch[1], 10) : null;

  // Extract week number (Week-15 or WK-51)
  const weekMatch = filename.match(/(?:Week|WK)[-_]0*(\d+)/i);
  const week = weekMatch ? parseInt(weekMatch[1], 10) : null;

  // Extract speaker name (last hyphen-separated part, no digits)
  const parts = filename.split('-');
  const speakerPart = parts[parts.length - 1];
  const speaker = /^[A-Za-z]+$/.test(speakerPart) ? speakerPart : null;

  if (day !== null && week !== null) {
    const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const dayName = day <= 7 ? dayNames[day] || `Day ${day}` : `Day ${day}`;
    const speakerSuffix = speaker ? ` (${speaker})` : '';
    return `Week ${week}, ${dayName}${speakerSuffix}`;
  }

  return filename;
}

/**
 * Return the Monday (UTC midnight) of the week that contains referenceDate.
 * The week is treated as Monday–Sunday.
 */
function weekMonday(referenceDate) {
  const d = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  // getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat  →  days since last Monday
  const daysToMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysToMonday);
  return d;
}

/**
 * Return the real calendar date (UTC midnight) for a given day number
 * (1=Monday … 7=Sunday) within the week that contains referenceDate.
 */
function pubDateForDay(dayNumber, referenceDate) {
  const monday = weekMonday(referenceDate);
  monday.setUTCDate(monday.getUTCDate() + dayNumber - 1);
  return monday;
}

/**
 * Format a JavaScript Date object as RFC 2822 (required by RSS).
 */
function toRFC2822(date) {
  return date.toUTCString();
}

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Unescape XML special characters (reverse of escapeXml).
 * &amp; must be replaced last to avoid double-unescaping (e.g. &amp;lt; → &lt;, not <).
 */
function unescapeXml(str) {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse episode objects from an existing RSS 2.0 feed XML string.
 * Returns an array of episode objects compatible with buildEpisodes output.
 */
function parseExistingFeed(xml) {
  if (!xml) return [];
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const durationMatch = block.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/);
    const enclosureLengthMatch = block.match(/<enclosure[^>]*\blength="(\d+)"[^>]*\/?>/i);
    if (!guidMatch) continue;
    const url = unescapeXml(guidMatch[1].trim());
    const title = titleMatch ? unescapeXml(titleMatch[1].trim()) : url;
    const description = descMatch ? unescapeXml(descMatch[1].trim()) : '';
    const pubDate = pubDateMatch ? new Date(pubDateMatch[1].trim()) : null;
    const duration = durationMatch ? unescapeXml(durationMatch[1].trim()) : null;
    const enclosureLength = enclosureLengthMatch ? parseInt(enclosureLengthMatch[1], 10) : null;
    episodes.push({ url, title, pubDate, description, duration, enclosureLength });
  }
  return episodes;
}

function parseDurationToSeconds(value) {
  if (value === null || value === undefined) return null;
  const input = String(value).trim();
  if (!input) return null;

  if (/^\d+(\.\d+)?$/.test(input)) {
    return Math.max(1, Math.round(Number(input)));
  }

  const parts = input.split(':');
  if (parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (seconds < 60) return (minutes * 60) + seconds;
  }

  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    if (minutes < 60 && seconds < 60) return (hours * 3600) + (minutes * 60) + seconds;
  }

  return null;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(1, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function estimateDurationSeconds(enclosureLength) {
  return Math.max(1, Math.round((enclosureLength * 8) / DEFAULT_MP3_BITRATE_BPS));
}

function parseLengthFromHeaders(headers) {
  if (!headers) return null;
  const contentLength = headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && parseInt(contentLength, 10) > 0) {
    return parseInt(contentLength, 10);
  }

  const contentRange = headers.get('content-range');
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match && parseInt(match[1], 10) > 0) return parseInt(match[1], 10);
  }

  return null;
}

async function resolveAudioMetadata(url, fetchImpl = globalThis.fetch) {
  let enclosureLength = null;
  let durationSeconds = null;

  try {
    const headResponse = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
    if (headResponse && headResponse.ok) {
      enclosureLength = parseLengthFromHeaders(headResponse.headers);
      durationSeconds =
        parseDurationToSeconds(headResponse.headers.get('content-duration'))
        || parseDurationToSeconds(headResponse.headers.get('x-content-duration'))
        || parseDurationToSeconds(headResponse.headers.get('x-duration'))
        || parseDurationToSeconds(headResponse.headers.get('x-amz-meta-duration'));
    }
  } catch {
    // Ignore and continue to GET range fallback.
  }

  if (!enclosureLength) {
    try {
      const rangeResponse = await fetchImpl(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
      });
      if (rangeResponse && rangeResponse.ok) {
        enclosureLength = parseLengthFromHeaders(rangeResponse.headers);
      }
    } catch {
      // Ignore and report unresolved metadata below.
    }
  }

  if (!enclosureLength) return null;
  if (!durationSeconds) durationSeconds = estimateDurationSeconds(enclosureLength);

  return {
    enclosureLength,
    duration: formatDuration(durationSeconds),
  };
}

function validateEpisode(ep) {
  if (!ep || typeof ep.title !== 'string' || ep.title.trim() === '') return 'missing title';
  if (!ep.url || typeof ep.url !== 'string' || !/^https?:\/\//i.test(ep.url)) return 'invalid enclosure URL';
  if (!Number.isInteger(ep.enclosureLength) || ep.enclosureLength <= 0) return 'invalid enclosure length';
  if (!(ep.pubDate instanceof Date) || Number.isNaN(ep.pubDate.getTime())) return 'invalid pubDate';
  if (!ep.duration || !/^\d{2,}:\d{2}:\d{2}$/.test(ep.duration)) return 'invalid duration';

  const [hours, minutes, seconds] = ep.duration.split(':').map((part) => parseInt(part, 10));
  if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds) || minutes >= 60 || seconds >= 60) {
    return 'invalid duration';
  }

  return null;
}

function partitionValidEpisodes(episodes) {
  const validEpisodes = [];
  const skippedEpisodes = [];

  episodes.forEach((ep) => {
    const reason = validateEpisode(ep);
    if (reason) {
      skippedEpisodes.push({ episode: ep, reason });
      return;
    }
    validEpisodes.push(ep);
  });

  return { validEpisodes, skippedEpisodes };
}

/**
 * Build an RSS 2.0 feed string from an array of episode objects.
 * Each episode: { url, title, pubDate (Date), description }
 */
function buildRSS(episodes) {
  const buildDate = toRFC2822(new Date());

  const items = episodes.map((ep) => {
    const title = escapeXml(ep.title);
    const desc = escapeXml(ep.description || ep.title);
    const url = escapeXml(ep.url);
    const pubDate = ep.pubDate ? toRFC2822(ep.pubDate) : buildDate;
    const duration = escapeXml(ep.duration);
    return `    <item>
      <title>${title}</title>
      <description>${desc}</description>
      <enclosure url="${url}" type="audio/mpeg" length="${ep.enclosureLength}"/>
      <guid isPermaLink="false">${url}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:duration>${duration}</itunes:duration>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Lectio for Families</title>
    <description>Daily family prayer audio from 24-7 Prayer — Lectio for Families</description>
    <link>${PRAY_URL}</link>
    <language>en</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <itunes:author>24-7 Prayer</itunes:author>
    <itunes:category text="Religion &amp; Spirituality">
      <itunes:category text="Christianity"/>
    </itunes:category>
    <atom:link href="https://anthonymastrean.github.io/lectio-for-families/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

function resolveMp3Url(url, baseUrl) {
  if (!url) return null;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/**
 * Extract the MP3 URL from devotional page HTML.
 * Supports the inline jQuery presto-player override and a src-attribute fallback.
 */
function extractMp3FromHtml(html, baseUrl) {
  if (!html) return null;

  // Primary: inline script that overrides the presto-player src via jQuery, e.g.:
  //   $('#presto-player-1').attr('src', 'https://downloads.24-7prayer.com/...mp3');
  // Also supports common quote variants.
  const inlineScriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  const scriptSrcRegex =
    /\$\(\s*(["'`])#presto-player[^"'`]*\1\s*\)\s*\.attr\s*\(\s*(["'`])src\2\s*,\s*(["'`])([^"'`]*\.mp3(?:\?[^"'`]*)?)\3/i;
  let scriptMatch;
  while ((scriptMatch = inlineScriptRegex.exec(html)) !== null) {
    const srcMatch = scriptMatch[1].match(scriptSrcRegex);
    if (srcMatch) return resolveMp3Url(srcMatch[4], baseUrl);
  }

  // Fallback: presto-player src attribute (may already reflect the jQuery value).
  const attrPatterns = [
    /<[^>]*\bid=(["'])presto-player[^"'<>]*\1[^>]*\bsrc=(["'])([^"']*\.mp3(?:\?[^"']*)?)\2[^>]*>/i,
    /<[^>]*\bsrc=(["'])([^"']*\.mp3(?:\?[^"']*)?)\1[^>]*\bid=(["'])presto-player[^"'<>]*\3[^>]*>/i,
  ];
  for (const pattern of attrPatterns) {
    const match = html.match(pattern);
    if (match) {
      const src = match[3] || match[2];
      if (src) return resolveMp3Url(src, baseUrl);
    }
  }

  return null;
}

/**
 * Extract the MP3 URL from an individual Lectio for Families devotional page.
 * The site uses a presto-player whose real src is set via an inline jQuery script.
 */
async function extractMp3FromDevotionalPage(page) {
  const html = await page.content();
  return extractMp3FromHtml(html, page.url());
}

async function gotoReady(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FEED_TIMEOUT });
  await page.waitForLoadState('networkidle', { timeout: PAGE_SETTLE_TIMEOUT }).catch(() => { });
}

/**
 * Use Playwright to scrape audio MP3 URLs from the Lectio for Families pray page.
 *
 * The site now hosts each day's audio on a separate /lff-devotional/ page rather
 * than embedding all players on the main /pray/ page.  We therefore:
 *   1. Visit the main page and collect all .lectio_item devotional links.
 *   2. Visit each individual page and extract the MP3 URL.
 *
 * Returns an array of absolute URL strings.
 */
async function scrapeAudioUrls() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; lectio-rss-bot/1.0; +https://github.com/AnthonyMastrean/lectio-for-families)',
  });
  const page = await context.newPage();

  const captured = new Set();

  // Keep network-level interception as a bonus catch for any MP3 request made
  // automatically by the player (e.g. prefetch / preload).
  page.on('request', (request) => {
    const url = request.url();
    if (/\.mp3(\?|$)/i.test(url)) captured.add(url);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (/\.mp3(\?|$)/i.test(url)) captured.add(url);
  });

  try {
    // ── Step 1: collect individual devotional page links ──────────────────────
    await gotoReady(page, PRAY_URL);
    // Wait for devotional links to be rendered; continue silently if they never appear
    await page.waitForSelector('a.lectio_item[href]', { timeout: FEED_TIMEOUT }).catch(() => { });

    const devotionalLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a.lectio_item[href]').forEach((el) => {
        if (/\/lff-devotional\//i.test(el.href)) links.push(el.href);
      });
      return [...new Set(links)];
    });

    // ── Step 2: visit each devotional page and grab the MP3 URL ───────────────
    if (devotionalLinks.length > 0) {
      for (const link of devotionalLinks) {
        try {
          await gotoReady(page, link);
          // Wait for the audio player element to be present; continue silently if absent
          await page.waitForSelector('[id^="presto-player"]', { timeout: FEED_TIMEOUT }).catch(() => { });

          const mp3Url = await extractMp3FromDevotionalPage(page);
          if (mp3Url) captured.add(mp3Url);
        } catch (err) {
          console.warn(`Skipping ${link}: ${err.message}`);
        }
      }
    } else {
      // ── Fallback: old behaviour – look for MP3 links directly on the main page
      await page.waitForSelector('audio, [data-src], [data-url]', { timeout: FEED_TIMEOUT }).catch(() => { });

      const domUrls = await page.evaluate(() => {
        const found = new Set();

        document.querySelectorAll('audio').forEach((el) => {
          if (el.src && /\.mp3(\?|$)/i.test(el.src)) found.add(el.src);
          el.querySelectorAll('source').forEach((s) => {
            if (s.src && /\.mp3(\?|$)/i.test(s.src)) found.add(s.src);
          });
        });

        document.querySelectorAll('a[href], source[src], [data-url], [data-src]').forEach((el) => {
          const candidate =
            el.getAttribute('href') ||
            el.getAttribute('src') ||
            el.getAttribute('data-url') ||
            el.getAttribute('data-src') ||
            '';
          if (/\.mp3(\?|$)/i.test(candidate)) {
            found.add(new URL(candidate, location.href).href);
          }
        });

        return [...found];
      });

      domUrls.forEach((u) => captured.add(u));
    }
  } finally {
    await browser.close();
  }

  return [...captured];
}

/**
 * Convert raw MP3 URLs into episode objects, sorted by day number.
 * referenceDate defaults to now and is used to anchor pubDates to the current week.
 */
function buildEpisodes(urls, referenceDate = new Date()) {
  // Filter to only MP3 audio files from downloads.24-7prayer.com
  const audioUrls = urls.filter((u) =>
    /downloads\.24-7prayer\.com/i.test(u) && /\.mp3(\?|$)/i.test(u),
  );

  if (audioUrls.length === 0) {
    if (urls.length > 0) {
      console.warn('No audio URLs found – the page may have changed structure.');
    }
    return [];
  }

  const episodes = audioUrls.map((url) => {
    const dayMatch = url.match(/Day[-_]0*(\d+)/i);
    const dayNumber = dayMatch ? parseInt(dayMatch[1], 10) : null;
    return {
      url,
      title: parseEpisodeTitle(url),
      pubDate: dayNumber !== null ? pubDateForDay(dayNumber, referenceDate) : null,
      description: 'Daily family prayer from 24-7 Prayer — Lectio for Families',
    };
  });

  // Sort by day number extracted from the URL (Day-01, Day-02 … Day-07)
  episodes.sort((a, b) => {
    const dayA = parseInt((a.url.match(/Day[-_]0*(\d+)/i) || [])[1], 10) || 0;
    const dayB = parseInt((b.url.match(/Day[-_]0*(\d+)/i) || [])[1], 10) || 0;
    return dayA - dayB;
  });

  return episodes;
}

async function main() {
  console.log(`Scraping ${PRAY_URL} …`);

  let urls;
  try {
    urls = await scrapeAudioUrls();
  } catch (err) {
    console.error('Playwright scrape failed:', err.message);
    process.exit(1);
  }

  console.log(`Found ${urls.length} MP3 URL(s):`);
  urls.forEach((u) => console.log('  ', u));

  const scrapedEpisodes = buildEpisodes(urls);
  const episodes = [];
  for (const ep of scrapedEpisodes) {
    const metadata = await resolveAudioMetadata(ep.url);
    episodes.push({ ...ep, ...metadata });
  }

  if (episodes.length === 0) {
    console.error('No episodes to write – aborting.');
    process.exit(1);
  }

  // Load and merge existing feed so that previous weeks' episodes are retained
  let existingEpisodes = [];
  if (fs.existsSync(FEED_FILE)) {
    try {
      const existingXml = fs.readFileSync(FEED_FILE, 'utf8');
      existingEpisodes = parseExistingFeed(existingXml);
      console.log(`Loaded ${existingEpisodes.length} existing episode(s) from ${FEED_FILE}.`);
    } catch (err) {
      console.warn(`Could not read existing feed: ${err.message}`);
    }
  }

  // New episodes take precedence; existing episodes not in the new batch are retained
  const newUrls = new Set(episodes.map((ep) => ep.url));
  const mergedEpisodes = [
    ...episodes,
    ...existingEpisodes.filter((ep) => !newUrls.has(ep.url)),
  ];

  // Sort by pubDate descending (newest first); episodes with no pubDate go last
  mergedEpisodes.sort((a, b) => {
    if (!a.pubDate && !b.pubDate) return 0;
    if (!a.pubDate) return 1;
    if (!b.pubDate) return -1;
    return b.pubDate - a.pubDate;
  });

  const { validEpisodes, skippedEpisodes } = partitionValidEpisodes(mergedEpisodes);
  skippedEpisodes.forEach(({ episode, reason }) => {
    console.warn(`Skipping feed item (${episode.url || episode.title || 'unknown'}): ${reason}`);
  });

  if (validEpisodes.length === 0) {
    console.error('No valid episodes to write – aborting.');
    process.exit(1);
  }

  const xml = buildRSS(validEpisodes);
  fs.writeFileSync(FEED_FILE, xml, 'utf8');
  console.log(`Wrote ${FEED_FILE}: total=${mergedEpisodes.length}, written=${validEpisodes.length}, skipped=${skippedEpisodes.length} (${episodes.length} new, ${existingEpisodes.length} previously existing).`);
}

// Export utilities so they can be tested independently
module.exports = {
  parseEpisodeTitle,
  buildRSS,
  buildEpisodes,
  escapeXml,
  unescapeXml,
  weekMonday,
  pubDateForDay,
  parseExistingFeed,
  parseDurationToSeconds,
  formatDuration,
  resolveAudioMetadata,
  partitionValidEpisodes,
};

// Run if invoked directly
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
