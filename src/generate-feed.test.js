'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseEpisodeTitle, buildRSS, buildEpisodes, escapeXml } = require('./generate-feed.js');

// ---------------------------------------------------------------------------
// parseEpisodeTitle
// ---------------------------------------------------------------------------
describe('parseEpisodeTitle', () => {
  it('parses the old Week-N-Day-N-Speaker pattern', () => {
    const url =
      'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-01-Chris.mp3';
    const title = parseEpisodeTitle(url);
    assert.equal(title, 'Week 15, Monday (Chris)');
  });

  it('parses the new Y2-WK-N-Day-N-Speaker pattern', () => {
    const url =
      'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2026-04-April/Y2-WK-51-Day-01-Phil.mp3';
    const title = parseEpisodeTitle(url);
    assert.equal(title, 'Week 51, Monday (Phil)');
  });

  it('handles Day-02 as Tuesday', () => {
    const url =
      'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-02-Chris.mp3';
    assert.equal(parseEpisodeTitle(url), 'Week 15, Tuesday (Chris)');
  });

  it('handles Day-07 as Sunday (full 7-day week)', () => {
    const url =
      'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-07-Chris.mp3';
    assert.equal(parseEpisodeTitle(url), 'Week 15, Sunday (Chris)');
  });

  it('returns filename when pattern is unrecognised', () => {
    const url = 'https://example.com/some-audio-file.mp3';
    const title = parseEpisodeTitle(url);
    assert.equal(title, 'some-audio-file');
  });
});

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------
describe('escapeXml', () => {
  it('escapes ampersands, angle brackets and quotes', () => {
    assert.equal(escapeXml('a & b'), 'a &amp; b');
    assert.equal(escapeXml('<tag>'), '&lt;tag&gt;');
    assert.equal(escapeXml('"quoted"'), '&quot;quoted&quot;');
  });
});

// ---------------------------------------------------------------------------
// buildEpisodes
// ---------------------------------------------------------------------------
describe('buildEpisodes', () => {
  const sampleUrls = [
    'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-02-Chris.mp3',
    'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-01-Chris.mp3',
    'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-03-Chris.mp3',
  ];

  it('returns one episode per URL', () => {
    const episodes = buildEpisodes(sampleUrls);
    assert.equal(episodes.length, 3);
  });

  it('sorts episodes by day number (keyed from URL, not title)', () => {
    const episodes = buildEpisodes(sampleUrls);
    assert.equal(episodes[0].title, 'Week 15, Monday (Chris)');
    assert.equal(episodes[1].title, 'Week 15, Tuesday (Chris)');
    assert.equal(episodes[2].title, 'Week 15, Wednesday (Chris)');
  });

  it('sorts a full 7-day week correctly (Mon–Sun)', () => {
    const urls = [7, 3, 1, 5, 2, 6, 4].map(
      (d) =>
        `https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-0${d}-Chris.mp3`,
    );
    const episodes = buildEpisodes(urls);
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    episodes.forEach((ep, i) => {
      assert.ok(ep.title.includes(dayNames[i]), `episode ${i} should be ${dayNames[i]}, got "${ep.title}"`);
    });
  });

  it('keeps 2024-dated URLs (content is reused across years)', () => {
    const oldYearUrl =
      'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-01-Chris.mp3';
    const episodes = buildEpisodes([oldYearUrl]);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].url, oldYearUrl);
  });

  it('returns empty array when no audio URLs supplied', () => {
    assert.deepEqual(buildEpisodes([]), []);
  });

  it('filters out non-audio URLs', () => {
    const mixed = [...sampleUrls, 'https://example.com/page.html'];
    const episodes = buildEpisodes(mixed);
    assert.equal(episodes.length, 3);
  });
});

// ---------------------------------------------------------------------------
// buildRSS
// ---------------------------------------------------------------------------
describe('buildRSS', () => {
  const episodes = [
    {
      url: 'https://downloads.24-7prayer.com/Lectio%20for%20Families/Audio/2024-04-April/Week-15-Day-01-Chris.mp3',
      title: 'Week 15, Monday (Chris)',
      pubDate: new Date('2024-04-08T00:00:00Z'),
      description: 'Daily family prayer from 24-7 Prayer — Lectio for Families',
    },
  ];

  it('produces valid RSS 2.0 XML', () => {
    const xml = buildRSS(episodes);
    assert.ok(xml.includes('<?xml version="1.0"'), 'missing XML declaration');
    assert.ok(xml.includes('<rss version="2.0"'), 'missing rss element');
    assert.ok(xml.includes('<channel>'), 'missing channel');
    assert.ok(xml.includes('</rss>'), 'missing closing rss tag');
  });

  it('includes the episode title and enclosure', () => {
    const xml = buildRSS(episodes);
    assert.ok(xml.includes('<title>Week 15, Monday (Chris)</title>'));
    assert.ok(xml.includes('<enclosure url="'));
    assert.ok(xml.includes('type="audio/mpeg"'));
  });

  it('escapes special characters in titles', () => {
    const epWithSpecialChars = [
      { ...episodes[0], title: 'Faith & Hope', description: '<desc>' },
    ];
    const xml = buildRSS(epWithSpecialChars);
    assert.ok(xml.includes('Faith &amp; Hope'));
    assert.ok(xml.includes('&lt;desc&gt;'));
  });

  it('returns empty channel when episodes array is empty', () => {
    const xml = buildRSS([]);
    assert.ok(xml.includes('<channel>'));
    assert.ok(!xml.includes('<item>'));
  });
});
