/*
 Fixture Intelligence — Broad Fixture Scanner

 Required Vercel Environment Variable:
   API_FOOTBALL_KEY

 API-Football provides the broader daily fixture calendar and
 historical match statistics. Sportmonks remains available for
 future enrichment/odds work.
*/

export default async function handler(req, res) {
  const apiKey = process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "API_FOOTBALL_KEY is not configured in Vercel.",
      setup: "Add API_FOOTBALL_KEY to the Production environment and redeploy."
    });
  }

  const date = String(
    req.query?.date || new Date().toISOString().slice(0, 10)
  );

  const API = "https://v3.football.api-sports.io";
  const headers = { "x-apisports-key": apiKey };

  async function api(path, params = {}) {
    const url = new URL(API + path);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url.toString(), { headers });
    const text = await response.text();

    let json;

    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `API-Football returned invalid JSON (${response.status})`
      );
    }

    if (!response.ok || (json.errors && Object.keys(json.errors).length)) {
      throw new Error(
        `API-Football error ${response.status}: ${
          typeof json.errors === "object"
            ? JSON.stringify(json.errors)
            : String(json.errors || "Unknown error")
        }`
      );
    }

    return json;
  }

  const num = value => {
    if (typeof value === "string") {
      const n = Number(value.replace("%", "").trim());
      return Number.isFinite(n) ? n : 0;
    }

    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  function statValue(statistics, names) {
    const wanted = names.map(x => x.toLowerCase());

    const item = (statistics || []).find(
      s => wanted.includes(String(s.type || "").toLowerCase())
    );

    return num(item?.value);
  }

  function extractTeamStats(statistics, teamId) {
    const block = (statistics || []).find(
      s => Number(s.team?.id) === Number(teamId)
    );

    const rows = block?.statistics || [];

    return {
      shots: statValue(rows, ["Total Shots"]),
      sot: statValue(rows, ["Shots on Goal"]),
      corners: statValue(rows, ["Corner Kicks"]),
      possession: statValue(rows, ["Ball Possession"]),
      attacks: statValue(rows, ["Attacks"]),
      dangerousAttacks: statValue(rows, ["Dangerous Attacks"]),
      crosses: statValue(rows, ["Crosses"])
    };
  }

  function scoreFor(fixture, teamId) {
    const side =
      Number(fixture.teams?.home?.id) === Number(teamId)
        ? "home"
        : "away";

    return num(fixture.goals?.[side]);
  }

  function toHistoryRecord(fixture, teamId) {
    const homeId = fixture.teams?.home?.id;
    const awayId = fixture.teams?.away?.id;
    const isHome = Number(homeId) === Number(teamId);

    const own = extractTeamStats(fixture.statistics, teamId);

    const opponent = extractTeamStats(
      fixture.statistics,
      isHome ? awayId : homeId
    );

    return {
      date: fixture.fixture?.date,
      shots: own.shots,
      shotsAgainst: opponent.shots,
      sot: own.sot,
      sotAgainst: opponent.sot,
      corners: own.corners,
      cornersAgainst: opponent.corners,
      goals: scoreFor(fixture, teamId),
      goalsAgainst: scoreFor(
        fixture,
        isHome ? awayId : homeId
      ),
      poss: own.possession,
      attacks: own.attacks || own.dangerousAttacks,
      crosses: own.crosses,
      home: isHome
    };
  }

  function weighted(values) {
    const clean = values.filter(v => Number.isFinite(v));

    if (!clean.length) return 0;

    let sum = 0;
    let weight = 0;

    clean.forEach((value, index) => {
      const w = index + 1;
      sum += value * w;
      weight += w;
    });

    return sum / weight;
  }

  function profile(history) {
    const last20 = history
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(a.date) - new Date(b.date)
      )
      .slice(-20);

    return {
      shots: weighted(last20.map(x => x.shots)),
      shotsAgainst: weighted(last20.map(x => x.shotsAgainst)),

      sot: weighted(last20.map(x => x.sot)),
      sotAgainst: weighted(last20.map(x => x.sotAgainst)),

      corners: weighted(last20.map(x => x.corners)),
      cornersAgainst: weighted(
        last20.map(x => x.cornersAgainst)
      ),

      goals: weighted(last20.map(x => x.goals)),
      goalsAgainst: weighted(
        last20.map(x => x.goalsAgainst)
      ),

      poss: weighted(last20.map(x => x.poss)),
      attacks: weighted(last20.map(x => x.attacks)),
      crosses: weighted(last20.map(x => x.crosses)),

      n: last20.length,

      homeN: last20.filter(x => x.home).length,
      awayN: last20.filter(x => !x.home).length
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /*
   Style matchup:
   possession + attacking volume + crossing pressure.
  */

  function styleAdjustment(team, opponent, market) {
    const possessionDiff =
      (team.poss || 50) -
      (opponent.poss || 50);

    const attackRatio =
      (team.attacks || 90) /
        Math.max(opponent.attacks || 90, 1) -
      1;

    const crossingRatio =
      (team.crosses || 15) /
        Math.max(opponent.crosses || 15, 1) -
      1;

    if (market === "corners") {
      return clamp(
        possessionDiff * 0.006 +
          attackRatio * 0.7 +
          crossingRatio * 0.35,
        -1.2,
        1.2
      );
    }

    if (market === "shots") {
      return clamp(
        possessionDiff * 0.004 +
          attackRatio * 0.8,
        -1.5,
        1.5
      );
    }

    if (market === "sot") {
      return clamp(
        possessionDiff * 0.003 +
          attackRatio * 0.5,
        -1,
        1
      );
    }

    return 0;
  }

  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * a);

    const y =
      1 -
      (((((1.061405429 * t - 1.453152027) * t) +
        1.421413741) * t -
        0.284496736) * t +
        0.254829592) *
        t *
        Math.exp(-a * a);

    return sign * y;
  }

  function normalCdf(z) {
    return 0.5 * (1 + erf(z / Math.sqrt(2)));
  }

  function overProbability(mean, line, sd) {
    return clamp(
      1 -
        normalCdf(
          (line - mean) /
            Math.max(sd, 0.5)
        ),
      0.01,
      0.99
    );
  }

  function grade(score) {
    if (score >= 80) return "strong";
    if (score >= 70) return "value";
    if (score >= 62) return "watch";

    return "avoid";
  }

  function addMarket(
    rows,
    meta,
    group,
    name,
    mean,
    line,
    sd,
    quality
  ) {
    const probability =
      overProbability(
        mean,
        line,
        sd
      );

    const confidence =
      Math.round(
        clamp(
          probability * 100 * quality,
          1,
          95
        )
      );

    rows.push({
      ...meta,

      group,
      name,

      mean,
      line,

      probability,

      score: confidence,
      confidence,

      grade: grade(confidence),

      quality
    });
  }

  function makePrediction(
    fixture,
    homeHistory,
    awayHistory
  ) {
    const h = profile(homeHistory);
    const a = profile(awayHistory);

    const home = fixture.teams.home;
    const away = fixture.teams.away;

    const sample =
      Math.min(h.n, a.n);

    const meta = {
      match:
        `${home.name} vs ${away.name}`,

      league:
        fixture.league?.name ||
        "Football",

      kickoff:
        fixture.fixture?.date,

      fixtureId:
        fixture.fixture?.id,

      sample
    };

    const quality =
      clamp(
        0.55 +
          (sample / 20) * 0.30 +
          (
            h.homeN >= 5 &&
            a.awayN >= 5
              ? 0.10
              : 0
          ),
        0.55,
        0.95
      );

    /*
      SHOTS
    */

    const homeShots =
      Math.max(
        0.2,

        h.shots * 0.55 +
        a.shotsAgainst * 0.45 +

        styleAdjustment(
          h,
          a,
          "shots"
        )
      );

    const awayShots =
      Math.max(
        0.2,

        a.shots * 0.55 +
        h.shotsAgainst * 0.45 +

        styleAdjustment(
          a,
          h,
          "shots"
        )
      );

    /*
      SHOTS ON TARGET
    */

    const homeSot =
      Math.max(
        0.1,

        h.sot * 0.55 +
        a.sotAgainst * 0.45 +

        styleAdjustment(
          h,
          a,
          "sot"
        )
      );

    const awaySot =
      Math.max(
        0.1,

        a.sot * 0.55 +
        h.sotAgainst * 0.45 +

        styleAdjustment(
          a,
          h,
          "sot"
        )
      );

    /*
      CORNERS
    */

    const homeCorners =
      Math.max(
        0.2,

        h.corners * 0.55 +
        a.cornersAgainst * 0.45 +

        styleAdjustment(
          h,
          a,
          "corners"
        )
      );

    const awayCorners =
      Math.max(
        0.2,

        a.corners * 0.55 +
        h.cornersAgainst * 0.45 +

        styleAdjustment(
          a,
          h,
          "corners"
        )
      );

    /*
      GOALS
    */

    const homeGoals =
      Math.max(
        0.05,

        h.goals * 0.55 +
        a.goalsAgainst * 0.45
      );

    const awayGoals =
      Math.max(
        0.05,

        a.goals * 0.55 +
        h.goalsAgainst * 0.45
      );

    const rows = [];

    /*
      TEAM SHOTS
    */

    addMarket(
      rows,
      meta,
      "shots",

      `${home.name} shots O10.5`,

      homeShots,
      10.5,

      Math.max(
        2.2,
        homeShots * 0.28
      ),

      quality
    );

    addMarket(
      rows,
      meta,
      "shots",

      `${away.name} shots O8.5`,

      awayShots,
      8.5,

      Math.max(
        2.2,
        awayShots * 0.28
      ),

      quality
    );

    /*
      MATCH SHOTS
    */

    addMarket(
      rows,
      meta,
      "shots",

      "Match shots O24.5",

      homeShots +
        awayShots,

      24.5,

      Math.max(
        3.5,
        (
          homeShots +
          awayShots
        ) * 0.23
      ),

      quality
    );

    /*
      TEAM SOT
    */

    addMarket(
      rows,
      meta,
      "sot",

      `${home.name} SOT O3.5`,

      homeSot,
      3.5,

      Math.max(
        1.1,
        homeSot * 0.28
      ),

      quality
    );

    addMarket(
      rows,
      meta,
      "sot",

      `${away.name} SOT O2.5`,

      awaySot,
      2.5,

      Math.max(
        1.1,
        awaySot * 0.28
      ),

      quality
    );

    /*
      MATCH SOT
    */

    addMarket(
      rows,
      meta,
      "sot",

      "Match SOT O7.5",

      homeSot +
        awaySot,

      7.5,

      Math.max(
        1.5,
        (
          homeSot +
          awaySot
        ) * 0.24
      ),

      quality
    );

    /*
      TEAM CORNERS
    */

    addMarket(
      rows,
      meta,
      "corners",

      `${home.name} corners O4.5`,

      homeCorners,
      4.5,

      Math.max(
        1.5,
        homeCorners * 0.27
      ),

      quality
    );

    addMarket(
      rows,
      meta,
      "corners",

      `${away.name} corners O3.5`,

      awayCorners,
      3.5,

      Math.max(
        1.5,
        awayCorners * 0.27
      ),

      quality
    );

    /*
      MATCH CORNERS
    */

    addMarket(
      rows,
      meta,
      "corners",

      "Match corners O8.5",

      homeCorners +
        awayCorners,

      8.5,

      Math.max(
        1.8,
        (
          homeCorners +
          awayCorners
        ) * 0.23
      ),

      quality
    );

    /*
      GOALS
    */

    addMarket(
      rows,
      meta,
      "goals",

      "Match goals O2.5",

      homeGoals +
        awayGoals,

      2.5,

      Math.max(
        0.75,
        (
          homeGoals +
          awayGoals
        ) * 0.38
      ),

      quality
    );

    addMarket(
      rows,
      meta,
      "goals",

      `${home.name} goals O0.5`,

      homeGoals,
      0.5,

      Math.max(
        0.55,
        homeGoals * 0.42
      ),

      quality
    );

    addMarket(
      rows,
      meta,
      "goals",

      `${away.name} goals O0.5`,

      awayGoals,
      0.5,

      Math.max(
        0.55,
        awayGoals * 0.42
      ),

      quality
    );

    /*
      MATCH RESULT
    */

    const homeRaw =
      clamp(
        0.50 +
          (
            homeGoals -
            awayGoals
          ) * 0.16,

        0.12,
        0.78
      );

    const awayRaw =
      clamp(
        0.50 +
          (
            awayGoals -
            homeGoals
          ) * 0.16,

        0.12,
        0.78
      );

    const drawRaw =
      clamp(
        1 -
          homeRaw -
          awayRaw +
          0.18,

        0.10,
        0.40
      );

    const total =
      homeRaw +
      awayRaw +
      drawRaw;

    [
      [
        `${home.name} to win`,
        homeRaw / total
      ],

      [
        "Draw",
        drawRaw / total
      ],

      [
        `${away.name} to win`,
        awayRaw / total
      ]

    ].forEach(
      ([name, probability]) => {

        const confidence =
          Math.round(
            clamp(
              probability *
                100 *
                quality,

              1,
              95
            )
          );

        rows.push({
          ...meta,

          group: "result",

          name,

          mean:
            probability,

          line: null,

          probability,

          score:
            confidence,

          confidence,

          grade:
            grade(confidence),

          quality
        });
      }
    );

    /*
      FIRST HALF ESTIMATES

      These are currently estimates from full-match rates.
      We will replace them with true first-half historical
      data in the next modelling layer.
    */

    addMarket(
      rows,
      meta,
      "firsthalf",

      "1H corners O4.5",

      (
        homeCorners +
        awayCorners
      ) * 0.46,

      4.5,

      Math.max(
        1.4,
        (
          homeCorners +
          awayCorners
        ) * 0.24
      ),

      quality * 0.88
    );

    addMarket(
      rows,
      meta,
      "firsthalf",

      "1H shots O11.5",

      (
        homeShots +
        awayShots
      ) * 0.46,

      11.5,

      Math.max(
        2.2,
        (
          homeShots +
          awayShots
        ) * 0.25
      ),

      quality * 0.88
    );

    addMarket(
      rows,
      meta,
      "firsthalf",

      "1H SOT O3.5",

      (
        homeSot +
        awaySot
      ) * 0.44,

      3.5,

      Math.max(
        1.1,
        (
          homeSot +
          awaySot
        ) * 0.26
      ),

      quality * 0.88
    );

    /*
      EXPLANATIONS
    */

    rows.forEach(row => {

      if (row.group === "corners") {

        row.why =
          "Last-20 corner production/concession + possession, attacking pressure and crossing profile.";

      } else if (row.group === "shots") {

        row.why =
          "Last-20 shots for/against + opponent shot concession + attacking pressure and style.";

      } else if (row.group === "sot") {

        row.why =
          "Last-20 SOT for/against + opponent SOT concession + attacking pressure and style.";

      } else if (row.group === "goals") {

        row.why =
          "Last-20 goals for/against + opponent defensive concession.";

      } else if (row.group === "firsthalf") {

        row.why =
          "Estimated from full-match rates; true first-half historical calibration will be added.";

      } else {

        row.why =
          "Attacking/defensive profile, opponent concessions and available historical sample.";

      }

    });

    return rows;
  }

  try {

    /*
      GET ALL FIXTURES FOR THE DATE
    */

    const fixtureResponse =
      await api(
        "/fixtures",
        {
          date,
          timezone: "UTC"
        }
      );

    const fixtures =
      (
        fixtureResponse.response ||
        []
      )
      .filter(
        f =>
          f.fixture?.status?.short !==
          "CANC"
      )
      .sort(
        (a, b) =>
          new Date(
            a.fixture?.date
          ) -
          new Date(
            b.fixture?.date
          )
      );

    /*
      We discover ALL fixtures first.

      Deep analysis is limited to the first 12
      until we add caching/optimization for the
      API request quota.
    */

    const analysisFixtures =
      fixtures.slice(0, 12);

    const historyCache =
      new Map();

    async function getTeamHistory(teamId) {

      if (
        historyCache.has(teamId)
      ) {
        return historyCache.get(
          teamId
        );
      }

      const response =
        await api(
          "/fixtures",
          {
            team: teamId,
            last: 20,
            status: "FT"
          }
        );

      const list =
        (
          response.response ||
          []
        )
        .sort(
          (a, b) =>
            new Date(
              a.fixture?.date
            ) -
            new Date(
              b.fixture?.date
            )
        )
        .slice(-20);

      const detailed = [];

      /*
        Fetch statistics for historical matches.
      */

      for (
        let i = 0;
        i < list.length;
        i += 20
      ) {

        const ids =
          list
          .slice(i, i + 20)
          .map(
            x =>
              x.fixture?.id
          )
          .filter(Boolean)
          .join("-");

        if (!ids) continue;

        const details =
          await api(
            "/fixtures",
            {
              ids
            }
          );

        detailed.push(
          ...(
            details.response ||
            []
          )
        );
      }

      const records =
        detailed
        .filter(
          x =>
            Array.isArray(
              x.statistics
            )
        )
        .map(
          x =>
            toHistoryRecord(
              x,
              teamId
            )
        );

      historyCache.set(
        teamId,
        records
      );

      return records;
    }

    const rows = [];

    let analysed = 0;
    let insufficient = 0;

    for (
      const fixture of
      analysisFixtures
    ) {

      const homeId =
        fixture.teams?.home?.id;

      const awayId =
        fixture.teams?.away?.id;

      if (
        !homeId ||
        !awayId
      ) {
        insufficient++;
        continue;
      }

      const [
        homeHistory,
        awayHistory
      ] =
        await Promise.all([
          getTeamHistory(
            homeId
          ),

          getTeamHistory(
            awayId
          )
        ]);

      if (
        homeHistory.length < 5 ||
        awayHistory.length < 5
      ) {
        insufficient++;
        continue;
      }

      rows.push(
        ...makePrediction(
          fixture,
          homeHistory,
          awayHistory
        )
      );

      analysed++;
    }

    /*
      IMPORTANT:
      fixtures = ALL fixtures discovered today
      analysed = fixtures actually modelled
      insufficient = fixtures without enough data
    */

    return res.status(200).json({

      date,

      source:
        "API-Football",

      fixtures:
        fixtures.length,

      analysed,

      insufficient,

      analysisLimit:
        analysisFixtures.length,

      rows

    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({

      error:
        error?.message ||
        "Scanner failed",

      date

    });
  }
      }
