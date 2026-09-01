export default async function handler(req, res) {
  const token = process.env.SPORTMONKS_TOKEN;

  if (!token) {
    return res.status(500).json({
      error:
        "SPORTMONKS_TOKEN is not configured in Vercel Production environment variables."
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
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        cache: "no-store"
      });

      const text = await response.text();

      let body;

      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }

      if (!response.ok) {
        const message =
          body?.message ||
          body?.error ||
          text ||
          "Unknown SportMonks error";

        throw new Error(`SportMonks ${response.status}: ${message}`);
      }

      return body;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(
          `SportMonks request timed out: ${path}`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function val(stat, names) {
    if (!stat) return null;

    const name = String(
      stat.type?.name ||
        stat.type?.developer_name ||
        stat.type ||
        ""
    ).toLowerCase();

    if (!names.some((n) => name.includes(n))) {
      return null;
    }

    const raw =
      stat.data?.value ??
      stat.value ??
      stat.data;

    const number = Number(raw);

    return Number.isFinite(number) ? number : 0;
  }

  function statLocation(stat) {
    return String(
      stat?.location ||
        stat?.meta?.location ||
        ""
    ).toLowerCase();
  }

  function statValue(stats, names, location) {
    const hit = (stats || []).find((stat) => {
      const value = val(stat, names);

      if (value === null) {
        return false;
      }

      if (!location) {
        return true;
      }

      return statLocation(stat) === location;
    });

    return hit ? val(hit, names) : 0;
  }

  function teamIdFromFixture(fixture, side) {
    const participants = fixture.participants || [];

    const item =
      participants.find(
        (x) =>
          String(x.meta?.location || "").toLowerCase() === side
      ) ||
      participants.find(
        (x) =>
          String(x.location || "").toLowerCase() === side
      );

    return (
      item?.id ||
      item?.team_id ||
      item?.participant_id
    );
  }

  function nameFromFixture(fixture, side) {
    const participants = fixture.participants || [];

    const item =
      participants.find(
        (x) =>
          String(x.meta?.location || "").toLowerCase() === side
      ) ||
      participants.find(
        (x) =>
          String(x.location || "").toLowerCase() === side
      );

    if (item?.name) {
      return item.name;
    }

    const parts = String(fixture.name || "").split(" vs ");

    return (
      side === "home"
        ? parts[0]
        : parts[1]
    ) || side;
  }

  function fixtureToRow(fixture, teamId) {
    const homeId = teamIdFromFixture(
      fixture,
      "home"
    );

    const awayId = teamIdFromFixture(
      fixture,
      "away"
    );

    const stats = fixture.statistics || [];

    const side =
      String(homeId) === String(teamId)
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

      poss: statValue(
        stats,
        [
          "possession",
          "ball possession"
        ],
        side
      ),

      attacks: statValue(
        stats,
        [
          "attacks",
          "dangerous attacks"
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
    const usable = values.filter((value) =>
      Number.isFinite(value)
    );

    if (!usable.length) {
      return 0;
    }

    let sum = 0;
    let weightSum = 0;

    usable.slice(-20).forEach(
      (value, index) => {
        const weight = index + 1;

        sum += value * weight;
        weightSum += weight;
      }
    );

    return weightSum
      ? sum / weightSum
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

      poss: weighted(
        history.map((x) => x.poss)
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

  function adjust(team, opponent, market) {
    const possession =
      (team.poss || 50) -
      (opponent.poss || 50);

    const pressure =
      (team.attacks || 0) /
        (opponent.attacks || 1) -
      1;

    const width =
      (team.crosses || 0) /
        (opponent.crosses || 1) -
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

    return Math.max(
      -1,
      Math.min(
        1,
        possession * 0.003 +
          pressure * 0.5
      )
    );
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

  function cdf(z) {
    return (
      0.5 *
      (
        1 +
        erf(z / Math.sqrt(2))
      )
    );
  }

  function over(mean, line, sd) {
    return Math.max(
      0.01,
      Math.min(
        0.99,
        1 -
          cdf(
            (line - mean) /
              Math.max(sd, 1)
          )
      )
    );
  }

  function predict(
    fixture,
    homeHistory,
    awayHistory
  ) {
    const home = profile(homeHistory);
    const away = profile(awayHistory);

    const homeShots =
      home.shots * 0.55 +
      away.shotsAgainst * 0.45 +
      adjust(
        home,
        away,
        "shots"
      );

    const awayShots =
      away.shots * 0.55 +
      home.shotsAgainst * 0.45 +
      adjust(
        away,
        home,
        "shots"
      );

    const homeSot =
      home.sot * 0.55 +
      away.sotAgainst * 0.45;

    const awaySot =
      away.sot * 0.55 +
      home.sotAgainst * 0.45;

    const homeCorners =
      home.corners * 0.55 +
      away.cornersAgainst * 0.45 +
      adjust(
        home,
        away,
        "corners"
      );

    const awayCorners =
      away.corners * 0.55 +
      home.cornersAgainst * 0.45 +
      adjust(
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
        homeSot,
        3.5
      ],

      [
        "sot",
        `${fixture.away} SOT`,
        awaySot,
        2.5
      ],

      [
        "sot",
        "Match SOT",
        homeSot + awaySot,
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
        const sd =
          market === "corners"
            ? Math.max(
                1.8,
                mean * 0.25
              )
            : market === "sot"
              ? Math.max(
                  1.4,
                  mean * 0.24
                )
              : Math.max(
                  3,
                  mean * 0.24
                );

        const probability =
          over(
            mean,
            line,
            sd
          );

        const score = Math.round(
          Math.max(
            1,
            Math.min(
              95,
              probability * 100
            )
          )
        );

        return {
          match: `${fixture.home} vs ${fixture.away}`,

          league:
            fixture.league?.name ||
            fixture.league ||
            "Football",

          market,

          name,

          mean,

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

          // IMPORTANT:
          // Convert number of matches to the
          // frontend's 0-20 quality scale.
          quality:
            Math.min(
              home.n,
              away.n
            ) / 20,

          why:
            `Weighted last-${Math.min(
              home.n,
              20
            )} history, opponent concession and style pressure.`
        };
      }
    );
  }

  try {
    // Get today's fixtures
    const fixtureJson = await get(
      `/fixtures/date/${date}`,
      {
        include:
          "participants;league"
      }
    );

    const fixtures =
      (fixtureJson.data || [])
        .filter(
          (fixture) =>
            !fixture.state_id ||
            [1, 2, 3].includes(
              Number(
                fixture.state_id
              )
            )
        );

    // Limit the number of fixtures so
    // Vercel does not time out.
    const fixturesToScan =
      fixtures.slice(0, 12);

    const rows = [];

    for (const fixture of fixturesToScan) {
      const homeId =
        teamIdFromFixture(
          fixture,
          "home"
        );

      const awayId =
        teamIdFromFixture(
          fixture,
          "away"
        );

      if (!homeId || !awayId) {
        continue;
      }

      const start =
        new Date(
          new Date(
            fixture.starting_at
          ).getTime() -
            1000 *
              60 *
              60 *
              24 *
              180
        )
          .toISOString()
          .slice(0, 10);

      /*
       * IMPORTANT FIX:
       * SportMonks historical fixture endpoint
       * uses /between/date/
       */

      const [
        homeJson,
        awayJson
      ] = await Promise.all([
        get(
          `/fixtures/between/date/${start}/${date}/${homeId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50,
            order: "desc"
          }
        ),

        get(
          `/fixtures/between/date/${start}/${date}/${awayId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50,
            order: "desc"
          }
        )
      ]);

      const fixtureTime =
        new Date(
          fixture.starting_at
        );

      const homeHistory =
        (homeJson.data || [])
          .filter(
            (item) =>
              new Date(
                item.starting_at
              ) < fixtureTime
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
            (item) =>
              fixtureToRow(
                item,
                homeId
              )
          );

      const awayHistory =
        (awayJson.data || [])
          .filter(
            (item) =>
              new Date(
                item.starting_at
              ) < fixtureTime
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
            (item) =>
              fixtureToRow(
                item,
                awayId
              )
          );

      rows.push(
        ...predict(
          {
            home:
              nameFromFixture(
                fixture,
                "home"
              ),

            away:
              nameFromFixture(
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
        fixturesToScan.length,

      rows
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error?.message ||
        "Live SportMonks scan failed."
    });
  }
    }
