# lectio-for-families

[![Update RSS Feed](https://github.com/AnthonyMastrean/lectio-for-families/actions/workflows/update-feed.yml/badge.svg)](https://github.com/AnthonyMastrean/lectio-for-families/actions/workflows/update-feed.yml)

An RSS feed for [Lectio for Families](https://www.24-7prayer.com/lectioforfamilies/) by 24-7 Prayer,
built to connect to a [Yoto](https://yoto.io/) player MYO card.

## Feed URL

```
https://raw.githubusercontent.com/AnthonyMastrean/lectio-for-families/main/feed.xml
```

The feed is refreshed every Monday morning (06:00 UTC) via a GitHub Actions workflow,
and can also be triggered manually from the [Actions tab](../../actions/workflows/update-feed.yml).

> **Where does `feed.xml` live?** It is committed directly to the `main` branch of this repository
> and served via GitHub's raw content CDN. This gives a stable, permanent URL that never expires —
> unlike workflow artifacts (90-day expiry) or releases (which require manual management).

## Setting up a Yoto MYO card

1. Open the [Yoto app](https://yoto.io/app/) and tap **My Cards → Make Your Own**.
2. Create a new card (or edit an existing one).
3. Tap **Add content → Podcast / RSS feed**.
4. Paste the feed URL above and tap **Add**.
5. The app will populate one track per day of the current week (Monday–Sunday).
6. Write the card and insert it into your Yoto player.

Each Monday morning the feed updates automatically. Pull to refresh inside the Yoto app
(or re-write the card) to pick up the new week's episodes.

## How it works

[`src/generate-feed.js`](src/generate-feed.js) uses [Playwright](https://playwright.dev/) to open
the [Lectio for Families pray page](https://www.24-7prayer.com/lectioforfamilies/pray/),
intercepts any MP3 network requests the JavaScript player makes, and also scans the DOM for
audio elements and `<a>` links. The discovered URLs are assembled into a standard RSS 2.0
podcast feed and written to `feed.xml`.

Each item's `<pubDate>` is resolved to the real calendar date for the current week:
Day 1 → this Monday, Day 2 → this Tuesday, …, Day 7 → this Sunday.

> **Note on URL years:** The site reuses audio from previous years (e.g. files stored under
> `2024-04-April/` may be the current week's content). The scraper keeps all discovered MP3
> URLs regardless of the year in their path.

## Local usage

```sh
npm ci
npx playwright install chromium --with-deps
npm run generate     # writes feed.xml
npm test             # unit tests (no browser required)
```

