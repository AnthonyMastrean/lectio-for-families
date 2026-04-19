# lectio-for-families
An RSS feed for Lectio for Families by 24-7 Prayer to connect to a Yoto player MYO card

## Feed URL

```
https://raw.githubusercontent.com/AnthonyMastrean/lectio-for-families/main/feed.xml
```

The feed is refreshed every Monday morning (06:00 UTC) via a GitHub Actions workflow,
and can also be triggered manually from the [Actions tab](../../actions/workflows/update-feed.yml).

## How it works

[`src/generate-feed.js`](src/generate-feed.js) uses [Playwright](https://playwright.dev/) to open
the [Lectio for Families pray page](https://www.24-7prayer.com/lectioforfamilies/pray/),
intercepts any MP3 network requests the JavaScript player makes, and also scans the DOM for
audio elements and `<a>` links. The discovered URLs are assembled into a standard RSS 2.0
podcast feed and written to `feed.xml`.

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

