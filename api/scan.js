/*
  Fixture Intelligence — Broad Daily Fixture Scanner
  Version 3.0 — FIXED to match app.js (shots + SOT + corners)

  API:
  API-Football / API-Sports

  Required Vercel Environment Variable:
  API_FOOTBALL_KEY

  WHAT WAS BROKEN:
  The previous version of this file only computed GOALS markets
  and returned { opportunities, fixturesScanned }. app.js expects
  { fixtures, rows } where each row is a shots/sot/corners market
  with { mean, line, p, score, grade, quality, why }. Because the
  field names never matched, app.js's scan() always fell back to
  an empty rows array -> nothing rendered, even though the daily
  fixture discovery itself was working fine.

  This version:
  - Keeps the working fixture discovery / pagination logic.
  - Pulls last-N match history per team (last=8 by default).
  - Fetches real per-match statistics (shots, shots on target,
    corners, possession) from API-Football's statistics endpoint,
    ONE call per unique historical fixture (covers both teams).
  - Runs the same weighting / normal-distribution probability math
    app.js uses client-side, so numbers are consistent whether you
    hit /api/scan or use "Load demo".
  - Returns { ok, fixtures, rows } so app.js renders it directly.

  QUOTA NOTE:
  Real per-match statistics cost 1 API call per unique historical
  fixture (not per team) thanks to caching by fixture ID, but this
  is still much heavier than the goals-only version. Tune
  MAX_DEEP_TEAMS and HISTORY_MATCHES below to fit your API plan's
  daily request limit. Lower these first if you hit 429s / quota
  errors.
*/

const API_BASE = "https://v3.football.api-sports.io";
const TIMEZONE = "Africa/Lagos";

// Tune these to your API-Football plan's daily quota.
const MAX_DEEP_TEAMS = 10;   // how many teams get full stats analysis
const HISTORY_MATCHES = 8;   // matches per team used for the model

/* -------------------------------------------------------
   Basic helpers
------------------------------------------------------- */

function todayLagos() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function avg(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// Same recency-weighted average app.js uses (oldest -> newest, newest weighted highest)
function weighted(values) {
  if (!values.length) return 0;
  let sw = 0, s = 0;
  values.slice(-20).forEach((v, i) => {
    const w = i + 1;
    s += v * w;
    sw += w;
  });
  return sw ? s / sw : 0;
}

/* -------------------------------------------------------
   Same probability math as app.js (kept identical so live
   results match "Load demo" behaviour)
------------------------------------------------------- */

function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return s * (
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t * Math.exp(-a * a)
  );
}

function normalCDF(z) {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

function overProb(mean, line, sd) {
  return Math.max(0.01, Math.min(0.99, 1 - normalCDF((line - mean) / Math.max(sd, 1))));
}

function styleAdjust(team, opp, market) {
  const pos = (team.poss || 50) - (opp.poss || 50);
  if (market === "corners") return clamp(pos * 0.006, -1.2, 1.2);
  if (market === "shots") return clamp(pos * 0.004, -1.5, 1.5);
  return clamp(pos * 0.003, -1, 1);
}

/* -------------------------------------------------------
   API request
------------------------------------------------------- */

async function apiRequest(endpoint, apiKey) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "GET",
    headers: { "x-apisports-key": apiKey, "Accept": "application/json" }
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(`API returned invalid JSON (${response.status})`);
  }

  if (!response.ok) {
    const message = data?.errors?.message || data?.message || `API request failed with status ${response.status}`;
    throw new Error(message);
  }

  if (data?.errors && Object.keys(data.errors).length) {
    throw new Error(typeof data.errors === "string" ? data.errors : JSON.stringify(data.errors));
  }

  return data;
}

/* -------------------------------------------------------
   Fixture retrieval (unchanged — this part was working)
------------------------------------------------------- */

async function getDailyFixtures(date, apiKey) {
  const endpoint = `/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(TIMEZONE)}`;
  const data = await apiRequest(endpoint, apiKey);
  const fixtures = Array.isArray(data.response) ? data.response : [];
  const paging = data.paging || { current: 1, total: 1 };

  let allFixtures = [...fixtures];
  const current = safeNumber(paging.current, 1);
  const total = safeNumber(paging.total, 1);

  if (total > current) {
    for (let page = current + 1; page <= total; page++) {
      const pageEndpoint = `/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(TIMEZONE)}&page=${page}`;
      const pageData = await apiRequest(pageEndpoint, apiKey);
      if (Array.isArray(pageData.response)) allFixtures.push(...pageData.response);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const fixture of allFixtures) {
    const id = fixture?.fixture?.id;
    if (!id) continue;
    if (!seen.has(id)) { seen.add(id); unique.push(fixture); }
  }

  const predictionStatuses = new Set(["NS", "TBD", "PST"]);
  const upcoming = unique.filter(item => predictionStatuses.has(item?.fixture?.status?.short));

  return { all: unique, upcoming: upcoming.length ? upcoming : unique };
}

async function getTeamHistory(teamId, apiKey) {
  if (!teamId) return [];
  const endpoint = `/fixtures?team=${teamId}&last=20&timezone=${encodeURIComponent(TIMEZONE)}`;
  const data = await apiRequest(endpoint, apiKey);
  return Array.isArray(data.response) ? data.response : [];
}

/* -------------------------------------------------------
   Real per-match statistics (shots / SOT / corners / poss)
------------------------------------------------------- */

function parseStatValue(raw) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "string" && raw.includes("%")) {
    return safeNumber(raw.replace("%", ""));
  }
  return safeNumber(raw);
}

function findStat(statsArray, typeName) {
  if (!Array.isArray(statsArray)) return 0;
  const match = statsArray.find(
    s => typeof s?.type === "string" && s.type.toLowerCase() === typeName.toLowerCase()
  );
  return match ? parseStatValue(match.value) : 0;
}

// Returns { [teamId]: { shots, sot, corners, poss } } or null if unavailable
async function getFixtureStatistics(fixtureId, apiKey) {
  try {
    const data = await apiRequest(`/fixtures/statistics?fixture=${fixtureId}`, apiKey);
    const teamsStats = Array.isArray(data.response) ? data.response : [];
    if (!teamsStats.length) return null;

    const result = {};
    for (const entry of teamsStats) {
      const teamId = entry?.team?.id;
      if (!teamId) continue;
      const stats = entry.statistics;
      result[teamId] = {
        shots: findStat(stats, "Total Shots"),
        sot: findStat(stats, "Shots on Goal"),
        corners: findStat(stats, "Corner Kicks"),
        poss: findStat(stats, "Ball Possession")
      };
    }
    return Object.keys(result).length ? result : null;
  } catch (error) {
    console.error(`Stats error for fixture ${fixtureId}:`, error.message);
    return null;
  }
}

/* -------------------------------------------------------
   Build per-team match-by-match record set with real stats
------------------------------------------------------- */

async function buildTeamHistoryStats(teamId, apiKey, statsCache) {
  const rawHistory = await getTeamHistory(teamId, apiKey);

  // Only finished matches, sorted oldest -> newest so weighted()
  // gives the most recent match the highest weight (matches app.js).
  const finished = rawHistory
    .filter(m => m?.fixture?.status?.short === "FT")
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))
    .slice(-HISTORY_MATCHES);

  const records = [];

  for (const match of finished) {
    const home = match?.teams?.home;
    const away = match?.teams?.away;
    if (!home || !away) continue;

    const isHome = home.id === teamId;
    const oppId = isHome ? away.id : home.id;
    const fixtureId = match?.fixture?.id;
    if (!fixtureId) continue;

    if (!statsCache.has(fixtureId)) {
      statsCache.set(fixtureId, await getFixtureStatistics(fixtureId, apiKey));
    }

    const statsForMatch = statsCache.get(fixtureId);
    if (!statsForMatch || !statsForMatch[teamId] || !statsForMatch[oppId]) {
      continue; // stats unavailable for this fixture (common in lower leagues) — skip it
    }

    const mine = statsForMatch[teamId];
    const theirs = statsForMatch[oppId];

    records.push({
      shots: mine.shots,
      shotsAgainst: theirs.shots,
      sot: mine.sot,
      sotAgainst: theirs.sot,
      corners: mine.corners,
      cornersAgainst: theirs.corners,
      poss: mine.poss
    });
  }

  return records;
}

function makeStats(history, oppHistory) {
  const shots = weighted(history.map(x => x.shots));
  const shotsAgainst = weighted(history.map(x => x.shotsAgainst));
  const sot = weighted(history.map(x => x.sot));
  const sotAgainst = weighted(history.map(x => x.sotAgainst));
  const corners = weighted(history.map(x => x.corners));
  const cornersAgainst = weighted(history.map(x => x.cornersAgainst));
  const poss = weighted(history.map(x => x.poss || 50));

  const oppShotsAgainst = weighted(oppHistory.map(x => x.shotsAgainst));
  const oppSotAgainst = weighted(oppHistory.map(x => x.sotAgainst));
  const oppCornersAgainst = weighted(oppHistory.map(x => x.cornersAgainst));
  const oppPoss = weighted(oppHistory.map(x => x.poss || 50));

  const shot = shots * 0.55 + oppShotsAgainst * 0.45 +
    styleAdjust({ poss }, { poss: oppPoss }, "shots");

  const s = sot * 0.55 + oppSotAgainst * 0.45;

  const cor = corners * 0.55 + oppCornersAgainst * 0.45 +
    styleAdjust({ poss }, { poss: oppPoss }, "corners");

  return { shots: shot, sot: s, corners: cor, n: history.length };
}

function reason(m, H, A) {
  if (m === "corners") return `Corner pressure from creation/concession rates and territorial (possession) profile. Sample: ${H.n}/${A.n} matches.`;
  if (m === "shots") return `Shot volume blended with opponent shot concession and possession profile. Sample: ${H.n}/${A.n} matches.`;
  return `SOT production blended with opponent SOT allowed. Sample: ${H.n}/${A.n} matches.`;
}

function buildRows(fixture, homeHistory, awayHistory) {
  const homeName = fixture?.teams?.home?.name || "Home";
  const awayName = fixture?.teams?.away?.name || "Away";
  const league = fixture?.league?.name || "Football";

  const H = makeStats(homeHistory, awayHistory);
  const A = makeStats(awayHistory, homeHistory);

  const lines = [
    ["shots", `${homeName} shots`, H.shots, 10.5],
    ["shots", `${awayName} shots`, A.shots, 8.5],
    ["shots", "Match shots", H.shots + A.shots, 24.5],
    ["sot", `${homeName} SOT`, H.sot, 3.5],
    ["sot", `${awayName} SOT`, A.sot, 2.5],
    ["sot", "Match SOT", H.sot + A.sot, 7.5],
    ["corners", `${homeName} corners`, H.corners, 4.5],
    ["corners", `${awayName} corners`, A.corners, 3.5],
    ["corners", "Match corners", H.corners + A.corners, 8.5]
  ];

  return lines.map(([market, name, mean, line]) => {
    const sd = market === "corners" ? Math.max(1.8, mean * 0.25)
      : market === "sot" ? Math.max(1.4, mean * 0.24)
      : Math.max(3, mean * 0.24);

    const p = overProb(mean, line, sd);
    const score = Math.round(clamp(p * 100, 1, 95));
    const grade = score >= 80 ? "strong" : score >= 70 ? "value" : score >= 62 ? "watch" : "avoid";
    const quality = Math.min(H.n, A.n) / HISTORY_MATCHES;

    return {
      match: `${homeName} vs ${awayName}`,
      league,
      market,
      name,
      mean,
      line,
      p,
      score,
      grade,
      quality,
      why: reason(market, H, A)
    };
  });
}

/* -------------------------------------------------------
   Main handler
------------------------------------------------------- */

export default async function handler(req, res) {
  try {
    const apiKey = process.env.API_FOOTBALL_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "API_FOOTBALL_KEY is not configured.",
        setup: "Add API_FOOTBALL_KEY to the Vercel Production environment."
      });
    }

    const requestedDate =
      typeof req.query?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : todayLagos();

    const fixtureData = await getDailyFixtures(requestedDate, apiKey);
    const fixtures = fixtureData.upcoming;

    const teamIds = new Set();
    for (const fixture of fixtures) {
      if (fixture?.teams?.home?.id) teamIds.add(fixture.teams.home.id);
      if (fixture?.teams?.away?.id) teamIds.add(fixture.teams.away.id);
    }

    const selectedTeamIds = Array.from(teamIds).slice(0, MAX_DEEP_TEAMS);
    const statsCache = new Map(); // fixtureId -> stats-by-team, shared across all teams to avoid duplicate calls

    const teamHistoryMap = new Map();
    for (const teamId of selectedTeamIds) {
      teamHistoryMap.set(teamId, await buildTeamHistoryStats(teamId, apiKey, statsCache));
    }

    const rows = [];
    for (const fixture of fixtures) {
      const homeId = fixture?.teams?.home?.id;
      const awayId = fixture?.teams?.away?.id;

      const homeHistory = teamHistoryMap.get(homeId) || [];
      const awayHistory = teamHistoryMap.get(awayId) || [];

      // Only produce markets once we have at least some real stats for both sides.
      if (homeHistory.length > 0 && awayHistory.length > 0) {
        rows.push(...buildRows(fixture, homeHistory, awayHistory));
      }
    }

    return res.status(200).json({
      ok: true,
      date: requestedDate,
      timezone: TIMEZONE,
      source: "API-Football",
      fixtures: fixtures.length,
      deepTeamsAnalysed: selectedTeamIds.length,
      deepTeamLimit: MAX_DEEP_TEAMS,
      historyMatchesPerTeam: HISTORY_MATCHES,
      rows,
      diagnostics: {
        apiConnected: true,
        message: rows.length
          ? "Fixture discovery and statistics analysis both working."
          : "Fixtures were found but no fixtures had usable shot/corner statistics yet (common for lower-tier leagues, or matches without played history)."
      }
    });

  } catch (error) {
    console.error("Scanner error:", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Unknown scanner error",
      hint: "Check API_FOOTBALL_KEY, Vercel deployment logs, and API quota."
    });
  }
    }
  
