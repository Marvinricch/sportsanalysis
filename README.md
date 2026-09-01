# Fixture Intelligence

A deployable football pre-match dashboard for shots, shots on target and corners.

## What is included

- Last-20-match recency weighting
- Home/away context through the fixture history
- Opponent shot/SOT/corner concessions
- Style adjustments using possession, attacks and crosses
- Match + team shots
- Match + team SOT
- Match + team corners
- Probability and 0–100 confidence score
- Strong / Value / Watch / Avoid grades
- Demo mode that works without an API
- Vercel serverless API route so your football API token stays server-side

## Data provider

The included adapter is written for Sportmonks Football API v3. Their current documentation exposes fixtures by date, fixtures by date range for a team, fixture statistics, xG and related data. See:
- https://www.sportmonks.com/football-api/
- https://www.sportmonks.com/glossary/fixtures/
- https://www.sportmonks.com/glossary/teams/

## Deploy on Vercel

1. Create a GitHub repository.
2. Upload this folder.
3. Import the repository into Vercel.
4. Add an environment variable:
   `SPORTMONKS_TOKEN = your_token`
5. Deploy.
6. Open the site and press **Scan today**.

The API token is never placed in the browser code.

## Run locally

This project is intentionally dependency-light. Vercel can run `api/scan.js` directly.

For local static preview, open `index.html`; Demo mode will work. Live API mode requires the serverless `/api/scan` route and `SPORTMONKS_TOKEN`.

## Important

This is a V1 research model, not a guaranteed betting system. Before relying on it, backtest predictions against historical data, track calibration and ROI, and add bookmaker odds so the value engine compares model probability against actual market price.

## V2 roadmap

- Better probability distributions for each market
- League-specific calibration
- Bookmaker odds/value engine
- xG/xGA weighting
- Injuries and expected lineups
- Referee/card/corner tendencies
- First-half markets
- Player shots/SOT props
- Automated daily scan and result tracking
- Historical prediction database
- Backtesting dashboard
