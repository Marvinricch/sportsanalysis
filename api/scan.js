export default async function handler(req, res) {
  const token = process.env.SPORTMONKS_TOKEN;

  if (!token) {
    return res.status(500).json({
      error: "SPORTMONKS_TOKEN is not configured in Vercel Production."
    });
  }

  const date = String(
    req.query.date || new Date().toISOString().slice(0, 10)
  );

  const base = "https://api.sportmonks.com/v3/football";

  const headers = {
    Authorization: token,
    Accept: "application/json"
  };

  async function get(path, params = {}) {
    const url = new URL(base + path);

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });

      const text = await response.text();

      let data = {};

      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        throw new Error(
          `SportMonks ${response.status}: ${
            data.message || data.error || text || "Request failed"
          }`
        );
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`SportMonks request timed out: ${path}`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function getStatValue(stat, names) {
    if (!stat) return null;

    const typeName = String(
      stat.type?.name ||
      stat.type?.developer_name ||
      stat.type ||
      ""
    ).toLowerCase();

    const matches = names.some((name) =>
      typeName.includes(name)
    );

    if (!matches) return null;

    const raw =
      stat.data?.value ??
      stat.value ??
      stat.data;

    const number = Number(raw);

    return Number.isFinite(number) ? number : 0;
  }

  function getLocation(stat) {
    return String(
      stat.location ||
      stat.meta?.location ||
      ""
    ).toLowerCase();
  }

  function statValue(stats, names, location) {
    const found = (stats || []).find((stat) => {
      const value = getStatValue(stat, names);

      if (value === null) return false;

      return getLocation(stat) === location;
    });

    return found
      ? getStatValue(found, names)
      : 0;
  }

  function teamId(fixture, side) {
    const participants = fixture.participants || [];

    const found =
      participants.find(
        (p) =>
          String(
            p.meta?.location || ""
          ).toLowerCase() === side
      ) ||
      participants.find(
        (p) =>
          String(
            p.location || ""
          ).toLowerCase() === side
      );

    return (
      found?.id ||
      found?.team_id ||
      found?.participant_id
    );
  }

  function teamName(fixture, side) {
    const participants = fixture.participants || [];

    const found =
      participants.find(
        (p) =>
          String(
            p.meta?.location || ""
          ).toLowerCase() === side
      ) ||
      participants.find(
        (p) =>
          String(
            p.location || ""
          ).toLowerCase() === side
      );

    if (found?.name) {
      return found.name;
    }

    const parts = String(
      fixture.name || ""
    ).split(" vs ");

    return (
      side === "home"
        ? parts[0]
        : parts[1]
    ) || side;
  }

  function fixtureStats(fixture, team) {
    const homeId = teamId(fixture, "home");
    const awayId = teamId(fixture, "away");

    const stats = fixture.statistics || [];

    const side =
      String(homeId) === String(team)
        ? "home"
        : "away";

    const opponent =
      side === "home"
        ? "away"
        : "home";

    return {
      date: fixture.starting_at,

      shots: statValue(
        stats,
        ["shots"],
        side
      ),

      shotsAgainst: statValue(
        stats,
        ["shots"],
        opponent
      ),

      sot: statValue(
        stats,
        [
          "shots on target",
          "shots on goal"
        ],
        side
      ),

      sotAgainst: statValue(
        stats,
        [
          "shots on target",
          "shots on goal"
        ],
        opponent
      ),

      corners: statValue(
        stats,
        ["corners"],
        side
      ),

      cornersAgainst: statValue(
        stats,
        ["corners"],
        opponent
      ),

      possession: statValue(
        stats,
        [
          "ball possession",
          "possession"
        ],
        side
      ),

      attacks: statValue(
        stats,
        [
          "dangerous attacks",
          "attacks"
        ],
        side
      ),

      crosses: statValue(
        stats,
        ["crosses"],
        side
      )
    };
  }

  function weighted(values) {
    const valid = values.filter(
      (x) => Number.isFinite(x)
    );

    if (!valid.length) return 0;

    let total = 0;
    let weightTotal = 0;

    valid.slice(-20).forEach(
      (value, index) => {
        const weight = index + 1;

        total += value * weight;
        weightTotal += weight;
      }
    );

    return weightTotal
      ? total / weightTotal
      : 0;
  }

  function profile(history) {
    return {
      shots: weighted(
        history.map((x) => x.shots)
      ),

      shotsAgainst: weighted(
        history.map((x) => x.shotsAgainst)
      ),

      sot: weighted(
        history.map((x) => x.sot)
      ),

      sotAgainst: weighted(
        history.map((x) => x.sotAgainst)
      ),

      corners: weighted(
        history.map((x) => x.corners)
      ),

      cornersAgainst: weighted(
        history.map((x) => x.cornersAgainst)
      ),

      possession: weighted(
        history.map((x) => x.possession)
      ),

      attacks: weighted(
        history.map((x) => x.attacks)
      ),

      crosses: weighted(
        history.map((x) => x.crosses)
      ),

      n: history.length
    };
  }

  function styleAdjustment(team, opponent, market) {
    const possession =
      (team.possession || 50) -
      (opponent.possession || 50);

    const pressure =
      (team.attacks || 0) /
        Math.max(
          opponent.attacks || 1,
          1
        ) -
      1;

    const width =
      (team.crosses || 0) /
        Math.max(
          opponent.crosses || 1,
          1
        ) -
      1;

    if (market === "corners") {
      return Math.max(
        -1.2,
        Math.min(
          1.2,
          possession * 0.006 +
            pressure * 0.7 +
            width * 0.35
        )
      );
    }

    if (market === "shots") {
      return Math.max(
        -1.5,
        Math.min(
          1.5,
          possession * 0.004 +
            pressure * 0.8
        )
      );
    }

    return 0;
  }

  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    const t =
      1 /
      (1 + 0.3275911 * a);

    return (
      sign *
      (
        1 -
        (
          (
            (
              1.061405429 * t -
              1.453152027
            ) *
              t +
            1.421413741
          ) *
            t -
          0.284496736
        ) *
          t +
        0.254829592
      ) *
        t *
        Math.exp(-a * a)
    );
  }

  function normalCDF(z) {
    return (
      0.5 *
      (1 + erf(z / Math.sqrt(2)))
    );
  }

  function overProbability(
    mean,
    line,
    sd
  ) {
    const probability =
      1 -
      normalCDF(
        (line - mean) /
          Math.max(sd, 1)
      );

    return Math.max(
      0.01,
      Math.min(0.99, probability)
    );
  }

  function predict(
    fixture,
    homeHistory,
    awayHistory
  ) {
    const home =
      profile(homeHistory);

    const away =
      profile(awayHistory);

    const homeShots =
      home.shots * 0.55 +
      away.shotsAgainst * 0.45 +
      styleAdjustment(
        home,
        away,
        "shots"
      );

    const awayShots =
      away.shots * 0.55 +
      home.shotsAgainst * 0.45 +
      styleAdjustment(
        away,
        home,
        "shots"
      );

    const homeSOT =
      home.sot * 0.55 +
      away.sotAgainst * 0.45;

    const awaySOT =
      away.sot * 0.55 +
      home.sotAgainst * 0.45;

    const homeCorners =
      home.corners * 0.55 +
      away.cornersAgainst * 0.45 +
      styleAdjustment(
        home,
        away,
        "corners"
      );

    const awayCorners =
      away.corners * 0.55 +
      home.cornersAgainst * 0.45 +
      styleAdjustment(
        away,
        home,
        "corners"
      );

    const markets = [
      [
        "shots",
        `${fixture.home} shots`,
        homeShots,
        10.5
      ],

      [
        "shots",
        `${fixture.away} shots`,
        awayShots,
        8.5
      ],

      [
        "shots",
        "Match shots",
        homeShots + awayShots,
        24.5
      ],

      [
        "sot",
        `${fixture.home} SOT`,
        homeSOT,
        3.5
      ],

      [
        "sot",
        `${fixture.away} SOT`,
        awaySOT,
        2.5
      ],

      [
        "sot",
        "Match SOT",
        homeSOT + awaySOT,
        7.5
      ],

      [
        "corners",
        `${fixture.home} corners`,
        homeCorners,
        4.5
      ],

      [
        "corners",
        `${fixture.away} corners`,
        awayCorners,
        3.5
      ],

      [
        "corners",
        "Match corners",
        homeCorners + awayCorners,
        8.5
      ]
    ];

    return markets.map(
      ([
        market,
        name,
        mean,
        line
      ]) => {
        const safeMean =
          Math.max(0, mean);

        const sd =
          market === "corners"
            ? Math.max(
                1.8,
                safeMean * 0.25
              )
            : market === "sot"
              ? Math.max(
                  1.4,
                  safeMean * 0.24
                )
              : Math.max(
                  3,
                  safeMean * 0.24
                );

        const probability =
          overProbability(
            safeMean,
            line,
            sd
          );

        const score =
          Math.round(
            Math.max(
              1,
              Math.min(
                95,
                probability * 100
              )
            )
          );

        return {
          match:
            `${fixture.home} vs ${fixture.away}`,

          league:
            fixture.league?.name ||
            fixture.league ||
            "Football",

          market,

          name,

          mean: safeMean,

          line,

          p: probability,

          score,

          grade:
            score >= 80
              ? "strong"
              : score >= 70
                ? "value"
                : score >= 62
                  ? "watch"
                  : "avoid",

          /*
           * IMPORTANT:
           * Frontend displays quality * 20.
           * Therefore quality must be 0-1.
           */
          quality:
            Math.min(
              home.n,
              away.n
            ) / 20,

          why:
            `Weighted historical data from up to ${Math.min(
              Math.min(home.n, away.n),
              20
            )} previous matches, opponent concessions and playing style.`
        };
      }
    );
  }

  try {
    /*
     * Today's fixtures
     */
    const fixtureResponse =
      await get(
        `/fixtures/date/${date}`,
        {
          include:
            "participants;league"
        }
      );

    const fixtures =
      (fixtureResponse.data || [])
        .filter(
          (fixture) =>
            fixture &&
            fixture.participants &&
            fixture.participants.length >= 2
        );

    const selected =
      fixtures.slice(0, 12);

    const rows = [];

    for (const fixture of selected) {
      const homeId =
        teamId(
          fixture,
          "home"
        );

      const awayId =
        teamId(
          fixture,
          "away"
        );

      if (!homeId || !awayId) {
        continue;
      }

      const fixtureDate =
        new Date(
          fixture.starting_at
        );

      const startDate =
        new Date(
          fixtureDate.getTime() -
            180 *
              24 *
              60 *
              60 *
              1000
        )
          .toISOString()
          .slice(0, 10);

      /*
       * IMPORTANT FIX:
       * This is the correct historical
       * SportMonks endpoint.
       */
      const [
        homeHistoryResponse,
        awayHistoryResponse
      ] = await Promise.all([
        get(
          `/fixtures/between/date/${startDate}/${date}/${homeId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50
          }
        ),

        get(
          `/fixtures/between/date/${startDate}/${date}/${awayId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50
          }
        )
      ]);

      const homeHistory =
        (homeHistoryResponse.data || [])
          .filter(
            (match) =>
              match.starting_at &&
              new Date(
                match.starting_at
              ) < fixtureDate
          )
          .sort(
            (a, b) =>
              new Date(
                a.starting_at
              ) -
              new Date(
                b.starting_at
              )
          )
          .slice(-20)
          .map(
            (match) =>
              fixtureStats(
                match,
                homeId
              )
          );

      const awayHistory =
        (awayHistoryResponse.data || [])
          .filter(
            (match) =>
              match.starting_at &&
              new Date(
                match.starting_at
              ) < fixtureDate
          )
          .sort(
            (a, b) =>
              new Date(
                a.starting_at
              ) -
              new Date(
                b.starting_at
              )
          )
          .slice(-20)
          .map(
            (match) =>
              fixtureStats(
                match,
                awayId
              )
          );

      if (
        !homeHistory.length ||
        !awayHistory.length
      ) {
        continue;
      }

      rows.push(
        ...predict(
          {
            home:
              teamName(
                fixture,
                "home"
              ),

            away:
              teamName(
                fixture,
                "away"
              ),

            league:
              fixture.league
          },

          homeHistory,

          awayHistory
        )
      );
    }

    return res.status(200).json({
      date,

      fixtures:
        fixtures.length,

      scanned:
        selected.length,

      rows
    });
  } catch (error) {
    console.error(
      "SportMonks scan error:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "SportMonks API scan failed."
    });
  }
  }
