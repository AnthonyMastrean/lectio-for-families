'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PRAY_URL = 'https://www.24-7prayer.com/lectioforfamilies/pray/';
const FEED_FILE = path.join(__dirname, '..', 'feed.xml');
const FEED_TIMEOUT = 60_000;

/**
 * Parse episode metadata from an MP3 filename or URL path.
 * Handles both historical and current naming schemes:
 *   Week-15-Day-01-Chris.mp3
 *   Y2-WK-51-Day-01-Phil.mp3
 */
function parseEpisodeTitle(url) {
  const filename = decodeURIComponent(url).split('/').pop().replace('.mp3', '');

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
    return `    <item>
      <title>${title}</title>
      <description>${desc}</description>
      <enclosure url="${url}" type="audio/mpeg" length="0"/>
      <guid isPermaLink="false">${url}</guid>
      <pubDate>${pubDate}</pubDate>
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

/**
 * Use Playwright to scrape audio MP3 URLs from the Lectio for Families pray page.
 * Returns an array of absolute URL strings.
 */
async function scrapeAudioUrls() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; lectio-rss-bot/1.0; +https://github.com/AnthonyMastrean/lectio-for-families)',
  });
  const page = await context.newPage();

  const captured = new Set();

  // Intercept all network requests – catch MP3 loads triggered by the player
  page.on('request', (request) => {
    const url = request.url();
    if (/\.mp3(\?|$)/i.test(url)) {
      captured.add(url);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (/\.mp3(\?|$)/i.test(url)) {
      captured.add(url);
    }
  });

  try {
    await page.goto(PRAY_URL, { waitUntil: 'networkidle', timeout: FEED_TIMEOUT });

    // Wait a little longer for lazy-loaded players
    await page.waitForTimeout(3000);

    // DOM search: audio elements, source elements, and <a> / <button> links
    const domUrls = await page.evaluate(() => {
      const found = new Set();

      document.querySelectorAll('audio').forEach((el) => {
        if (el.src && el.src.includes('.mp3')) found.add(el.src);
        el.querySelectorAll('source').forEach((s) => {
          if (s.src && s.src.includes('.mp3')) found.add(s.src);
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
  // Filter to only downloads.24-7prayer.com audio files
  const audioUrls = urls.filter((u) =>
    /downloads\.24-7prayer\.com/i.test(u) || /\.mp3(\?|$)/i.test(u),
  );

  if (audioUrls.length === 0) {
    console.warn('No audio URLs found – the page may have changed structure.');
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

  const episodes = buildEpisodes(urls);

  if (episodes.length === 0) {
    console.error('No episodes to write – aborting.');
    process.exit(1);
  }

  const xml = buildRSS(episodes);
  fs.writeFileSync(FEED_FILE, xml, 'utf8');
  console.log(`Wrote ${FEED_FILE} with ${episodes.length} episode(s).`);
}

// Export utilities so they can be tested independently
module.exports = { parseEpisodeTitle, buildRSS, buildEpisodes, escapeXml, weekMonday, pubDateForDay };

// Run if invoked directly
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
