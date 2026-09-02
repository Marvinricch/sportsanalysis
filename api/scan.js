/*
  Fixture Intelligence — Broad Daily Fixture Scanner
  Version 2.1

  API:
  API-Football / API-Sports

  Required Vercel Environment Variable:
  API_FOOTBALL_KEY

  Purpose:
  - Pull the complete fixture slate for a selected date
  - Use Africa/Lagos timezone
  - Do NOT artificially limit the number of discovered fixtures
  - Keep deep historical analysis controlled to protect API quota
*/

const API_BASE = "https://v3.football.api-sports.io";
const TIMEZONE = "Africa/Lagos";

/* -------------------------------------------------------
   Helpers
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

function average(values) {
  const valid = values
    .map(Number)
    .filter(Number.isFinite);

  if (!valid.length) return 0;

  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/* -------------------------------------------------------
   API request
------------------------------------------------------- */

async function apiRequest(endpoint, apiKey) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "GET",
    headers: {
      "x-apisports-key": apiKey,
      "Accept": "application/json"
    }
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    throw new Error(`API returned invalid JSON (${response.status})`);
  }

  if (!response.ok) {
    const message =
      data?.errors?.message ||
      data?.message ||
      `API request failed with status ${response.status}`;

    throw new Error(message);
  }

  if (data?.errors && Object.keys(data.errors).length) {
    throw new Error(
      typeof data.errors === "string"
        ? data.errors
        : JSON.stringify(data.errors)
    );
  }

  return data;
}

/* -------------------------------------------------------
   Fixture retrieval
------------------------------------------------------- */

async function getDailyFixtures(date, apiKey) {
  const endpoint =
    `/fixtures?date=${encodeURIComponent(date)}` +
    `&timezone=${encodeURIComponent(TIMEZONE)}`;

  const data = await apiRequest(endpoint, apiKey);

  const fixtures = Array.isArray(data.response)
    ? data.response
    : [];

  /*
    API-Football normally returns the date query as one response,
    but we still inspect paging so that a future pagination response
    doesn't silently truncate our fixture list.
  */

  const paging = data.paging || {
    current: 1,
    total: 1
  };

  let allFixtures = [...fixtures];

  const current = safeNumber(paging.current, 1);
  const total = safeNumber(paging.total, 1);

  if (total > current) {
    for (let page = current + 1; page <= total; page++) {
      const pageEndpoint =
        `/fixtures?date=${encodeURIComponent(date)}` +
        `&timezone=${encodeURIComponent(TIMEZONE)}` +
        `&page=${page}`;

      const pageData = await apiRequest(pageEndpoint, apiKey);

      if (Array.isArray(pageData.response)) {
        allFixtures.push(...pageData.response);
      }
    }
  }

  /*
    Remove accidental duplicate fixture IDs.
  */

  const unique = [];
  const seen = new Set();

  for (const fixture of allFixtures) {
    const id = fixture?.fixture?.id;

    if (!id) continue;

    if (!seen.has(id)) {
      seen.add(id);
      unique.push(fixture);
    }
  }

  /*
    Only upcoming / relevant matches for prediction.
    Finished matches are not prediction opportunities.
  */

  const predictionStatuses = new Set([
    "NS",
    "TBD",
    "PST"
  ]);

  const upcoming = unique.filter(item => {
    const status = item?.fixture?.status?.short;
    return predictionStatuses.has(status);
  });

  /*
    If filtering somehow produces nothing, return the complete
    fixture set rather than falsely reporting zero fixtures.
  */

  return {
    all: unique,
    upcoming: upcoming.length ? upcoming : unique,
    paging: {
      current,
      total
    }
  };
}

/* -------------------------------------------------------
   Last matches
------------------------------------------------------- */

async function getTeamHistory(teamId, apiKey) {
  if (!teamId) return [];

  const endpoint =
    `/fixtures?team=${teamId}` +
    `&last=20` +
    `&timezone=${encodeURIComponent(TIMEZONE)}`;

  const data = await apiRequest(endpoint, apiKey);

  return Array.isArray(data.response)
    ? data.response
    : [];
}

/* -------------------------------------------------------
   Extract match statistics
------------------------------------------------------- */

function getTeamFromFixture(fixture, teamId) {
  if (!fixture?.teams) return null;

  if (fixture.teams.home?.id === teamId) {
    return fixture.teams.home;
  }

  if (fixture.teams.away?.id === teamId) {
    return fixture.teams.away;
  }

  return null;
}

function extractTeamHistoryStats(history, teamId) {
  const matches = [];

  for (const match of history) {
    const home = match?.teams?.home;
    const away = match?.teams?.away;

    if (!home || !away) continue;

    const isHome = home.id === teamId;
    const isAway = away.id === teamId;

    if (!isHome && !isAway) continue;

    const team = isHome ? home : away;
    const opponent = isHome ? away : home;

    const goalsFor = isHome
      ? safeNumber(match?.goals?.home)
      : safeNumber(match?.goals?.away);

    const goalsAgainst = isHome
      ? safeNumber(match?.goals?.away)
      : safeNumber(match?.goals?.home);

    matches.push({
      fixtureId: match?.fixture?.id,
      date: match?.fixture?.date,

      homeAway: isHome ? "home" : "away",

      opponent: opponent?.name || "Unknown",

      goalsFor,
      goalsAgainst
    });
  }

  return matches.slice(0, 20);
}

/* -------------------------------------------------------
   Basic historical model
------------------------------------------------------- */

function buildHistoricalProfile(history, teamId) {
  const matches = extractTeamHistoryStats(history, teamId);

  if (!matches.length) {
    return {
      sample: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      homeMatches: 0,
      awayMatches: 0
    };
  }

  return {
    sample: matches.length,

    goalsFor: average(
      matches.map(m => m.goalsFor)
    ),

    goalsAgainst: average(
      matches.map(m => m.goalsAgainst)
    ),

    homeMatches: matches.filter(
      m => m.homeAway === "home"
    ).length,

    awayMatches: matches.filter(
      m => m.homeAway === "away"
    ).length
  };
}

/* -------------------------------------------------------
   Simple projection
------------------------------------------------------- */

function buildProjection(homeProfile, awayProfile) {
  const homeAttack = safeNumber(homeProfile.goalsFor);
  const awayAttack = safeNumber(awayProfile.goalsFor);

  const homeDefense = safeNumber(homeProfile.goalsAgainst);
  const awayDefense = safeNumber(awayProfile.goalsAgainst);

  const homeExpected =
    (homeAttack + awayDefense) / 2;

  const awayExpected =
    (awayAttack + homeDefense) / 2;

  return {
    homeGoals: Number(homeExpected.toFixed(2)),
    awayGoals: Number(awayExpected.toFixed(2)),
    totalGoals: Number(
      (homeExpected + awayExpected).toFixed(2)
    )
  };
}

/* -------------------------------------------------------
   Market probability helper
------------------------------------------------------- */

function overProbability(expected, line) {
  if (!Number.isFinite(expected)) return 0;

  /*
    Lightweight probability approximation.
    This is intentionally conservative.
    Later we will replace this with a richer statistical model.
  */

  const difference = expected - line;

  const probability =
    50 + difference * 17;

  return Math.round(
    clamp(probability, 1, 99)
  );
}

/* -------------------------------------------------------
   Create fixture analysis
------------------------------------------------------- */

function analyseFixture(fixture, homeProfile, awayProfile) {
  const homeName =
    fixture?.teams?.home?.name || "Home";

  const awayName =
    fixture?.teams?.away?.name || "Away";

  const projection =
    buildProjection(homeProfile, awayProfile);

  const totalGoals = projection.totalGoals;

  const markets = [];

  /*
    Goals
  */

  markets.push({
    market: "Match goals O1.5",
    projection: totalGoals,
    probability: overProbability(totalGoals, 1.5)
  });

  markets.push({
    market: "Match goals O2.5",
    projection: totalGoals,
    probability: overProbability(totalGoals, 2.5)
  });

  /*
    Team goals
  */

  markets.push({
    market: `${homeName} goals O0.5`,
    projection: projection.homeGoals,
    probability: overProbability(
      projection.homeGoals,
      0.5
    )
  });

  markets.push({
    market: `${awayName} goals O0.5`,
    projection: projection.awayGoals,
    probability: overProbability(
      projection.awayGoals,
      0.5
    )
  });

  /*
    Give each market a grade.
  */

  const gradedMarkets = markets.map(item => {
    let grade = "AVOID";

    if (item.probability >= 75) {
      grade = "STRONG";
    } else if (item.probability >= 65) {
      grade = "VALUE";
    } else if (item.probability >= 55) {
      grade = "WATCH";
    }

    return {
      ...item,
      confidence: item.probability,
      grade
    };
  });

  return {
    fixtureId: fixture?.fixture?.id,

    match: `${homeName} vs ${awayName}`,

    league:
      fixture?.league?.name || "Unknown competition",

    country:
      fixture?.league?.country || "",

    kickoff:
      fixture?.fixture?.date || null,

    teams: {
      home: {
        id: fixture?.teams?.home?.id,
        name: homeName
      },
      away: {
        id: fixture?.teams?.away?.id,
        name: awayName
      }
    },

    historical: {
      home: homeProfile,
      away: awayProfile
    },

    projection,

    markets: gradedMarkets
  };
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
        setup:
          "Add API_FOOTBALL_KEY to the Vercel Production environment."
      });
    }

    /*
      Allow frontend to request a specific date.

      Example:
      /api/scan?date=2026-09-02

      If no date is supplied, use today's Lagos date.
    */

    const requestedDate =
      typeof req.query?.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : todayLagos();

    /*
      STEP 1:
      Get the complete fixture slate.
    */

    const fixtureData =
      await getDailyFixtures(
        requestedDate,
        apiKey
      );

    const fixtures = fixtureData.upcoming;

    /*
      STEP 2:
      Deduplicate team IDs.

      This prevents repeated history calls when a team appears
      in only one fixture.
    */

    const teamIds = new Set();

    for (const fixture of fixtures) {
      const homeId = fixture?.teams?.home?.id;
      const awayId = fixture?.teams?.away?.id;

      if (homeId) teamIds.add(homeId);
      if (awayId) teamIds.add(awayId);
    }

    /*
      STEP 3:
      Historical data.

      IMPORTANT:
      We deliberately cap the number of teams deeply analysed.

      This protects the free API quota.

      The scanner still discovers ALL fixtures.
      Later we will create a smarter pre-filter so the model
      chooses the most promising fixtures before spending
      historical/statistics requests.
    */

    const MAX_DEEP_TEAMS = 12;

    const selectedTeamIds =
      Array.from(teamIds).slice(0, MAX_DEEP_TEAMS);

    const historyMap = new Map();

    for (const teamId of selectedTeamIds) {
      try {
        const history =
          await getTeamHistory(
            teamId,
            apiKey
          );

        historyMap.set(teamId, history);
      } catch (error) {
        console.error(
          `History error for team ${teamId}:`,
          error.message
        );

        historyMap.set(teamId, []);
      }
    }

    /*
      STEP 4:
      Analyse fixtures for which historical data exists.

      Fixtures without historical data are still returned,
      but marked as requiring deeper analysis.
    */

    const analyses = [];

    for (const fixture of fixtures) {
      const homeId =
        fixture?.teams?.home?.id;

      const awayId =
        fixture?.teams?.away?.id;

      const homeHistory =
        historyMap.get(homeId) || [];

      const awayHistory =
        historyMap.get(awayId) || [];

      const homeProfile =
        buildHistoricalProfile(
          homeHistory,
          homeId
        );

      const awayProfile =
        buildHistoricalProfile(
          awayHistory,
          awayId
        );

      /*
        Only produce a model projection when we have
        at least some historical information.
      */

      if (
        homeProfile.sample > 0 &&
        awayProfile.sample > 0
      ) {
        analyses.push(
          analyseFixture(
            fixture,
            homeProfile,
            awayProfile
          )
        );
      } else {
        analyses.push({
          fixtureId: fixture?.fixture?.id,

          match:
            `${fixture?.teams?.home?.name || "Home"} vs ` +
            `${fixture?.teams?.away?.name || "Away"}`,

          league:
            fixture?.league?.name || "Unknown competition",

          country:
            fixture?.league?.country || "",

          kickoff:
            fixture?.fixture?.date || null,

          teams: fixture?.teams,

          grade: "WATCH",

          markets: [],

          historical: {
            home: homeProfile,
            away: awayProfile
          },

          message:
            "Fixture discovered. Waiting for deeper historical analysis."
        });
      }
    }

    /*
      STEP 5:
      Flatten markets for the frontend.

      This keeps compatibility with the existing dashboard.
    */

    const opportunities = [];

    for (const analysis of analyses) {
      for (const market of analysis.markets || []) {
        opportunities.push({
          fixtureId: analysis.fixtureId,

          match: analysis.match,

          league: analysis.league,

          country: analysis.country,

          kickoff: analysis.kickoff,

          market: market.market,

          projection: market.projection,

          probability: market.probability,

          confidence: market.confidence,

          grade: market.grade,

          sample:
            Math.min(
              analysis.historical?.home?.sample || 0,
              analysis.historical?.away?.sample || 0
            ),

          reason:
            "Weighted historical data from available previous matches."
        });
      }
    }

    /*
      Highest confidence first.
    */

    opportunities.sort(
      (a, b) =>
        safeNumber(b.confidence) -
        safeNumber(a.confidence)
    );

    const confidenceValues =
      opportunities
        .map(o => safeNumber(o.confidence))
        .filter(v => v > 0);

    const averageConfidence =
      confidenceValues.length
        ? Math.round(
            average(confidenceValues)
          )
        : 0;

    const strongSignals =
      opportunities.filter(
        o => o.grade === "STRONG"
      ).length;

    const valueSignals =
      opportunities.filter(
        o => o.grade === "VALUE"
      ).length;

    /*
      Response
    */

    return res.status(200).json({
      ok: true,

      date: requestedDate,

      timezone: TIMEZONE,

      source: "API-Football",

      fixturesScanned: fixtures.length,

      fixturesReturnedByAPI:
        fixtureData.all.length,

      fixturesUpcoming:
        fixtureData.upcoming.length,

      paging: fixtureData.paging,

      deepTeamsAnalysed:
        selectedTeamIds.length,

      deepTeamLimit:
        MAX_DEEP_TEAMS,

      strongSignals,

      valueSignals,

      averageConfidence,

      opportunities,

      fixtures: analyses,

      diagnostics: {
        apiConnected: true,

        message:
          "Daily fixture discovery is working. Deep historical analysis is intentionally quota-controlled.",

        nextUpgrade:
          "Rank all fixtures first, then spend historical/statistics requests only on the strongest candidates."
      }
    });

  } catch (error) {
    console.error("Scanner error:", error);

    return res.status(500).json({
      ok: false,

      error:
        error?.message ||
        "Unknown scanner error",

      hint:
        "Check API_FOOTBALL_KEY, Vercel deployment logs, and API quota."
    });
  }
}
