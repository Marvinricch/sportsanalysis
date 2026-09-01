export default async function handler(req, res) {
  const token = process.env.SPORTMONKS_TOKEN;

  if (!token) {
    return res.status(500).json({
      error:
        "SPORTMONKS_TOKEN is not configured in the Production environment."
    });
  }

  const date =
    String(req.query.date || new Date().toISOString().slice(0, 10));

  const base =
    "https://api.sportmonks.com/v3/football";

  async function get(path, params = {}) {
    const url = new URL(base + path);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    });

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      15000
    );

    try {
      const response = await fetch(url, {
        method: "GET",

        headers: {
          Authorization: token,
          Accept: "application/json"
        },

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
        const message =
          data?.message ||
          data?.error ||
          text ||
          `SportMonks returned HTTP ${response.status}`;

        throw new Error(
          `SportMonks ${response.status}: ${message}`
        );
      }

      return data;

    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "SportMonks request timed out after 15 seconds."
        );
      }

      throw error;

    } finally {
      clearTimeout(timeout);
    }
  }

  function val(stat, names) {
    if (!stat) return 0;

    const name = String(
      stat.type?.name ||
      stat.type?.developer_name ||
      stat.type ||
      ""
    ).toLowerCase();

    if (!names.some(n => name.includes(n))) {
      return null;
    }

    const raw =
      stat.data?.value ??
      stat.value ??
      stat.data;

    const number = Number(raw);

    return Number.isFinite(number)
      ? number
      : 0;
  }

  function statValue(stats, names, location) {
    const hit = (stats || []).find(stat => {
      const value = val(stat, names);

      if (value === null) {
        return false;
      }

      if (!location) {
        return true;
      }

      return String(
        stat.location || ""
      ).toLowerCase() === location;
    });

    return hit
      ? val(hit, names)
      : 0;
  }

  function teamIdFromFixture(fixture, side) {
    const participants =
      fixture.participants || [];

    const item =
      participants.find(
        x =>
          String(
            x.meta?.location || ""
          ).toLowerCase() === side
      ) ||
      participants.find(
        x =>
          String(
            x.location || ""
          ).toLowerCase() === side
      );

    return (
      item?.id ||
      item?.team_id ||
      item?.participant_id
    );
  }

  function nameFromFixture(fixture, side) {
    const participants =
      fixture.participants || [];

    const item =
      participants.find(
        x =>
          String(
            x.meta?.location || ""
          ).toLowerCase() === side
      ) ||
      participants.find(
        x =>
          String(
            x.location || ""
          ).toLowerCase() === side
      );

    if (item?.name) {
      return item.name;
    }

    const parts =
      String(fixture.name || "")
        .split(" vs ");

    return (
      side === "home"
        ? parts[0]
        : parts[1]
    ) || side;
  }

  function fixtureToRow(fixture, teamId) {
    const homeId =
      teamIdFromFixture(fixture, "home");

    const awayId =
      teamIdFromFixture(fixture, "away");

    const stats =
      fixture.statistics || [];

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
        ["possession"],
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
    const valid =
      values.filter(
        x => Number.isFinite(x)
      );

    if (!valid.length) {
      return 0;
    }

    let sum = 0;
    let weight = 0;

    valid
      .slice(-20)
      .forEach((value, index) => {
        const w = index + 1;

        sum += value * w;
        weight += w;
      });

    return weight
      ? sum / weight
      : 0;
  }

  function profile(history) {
    return {
      shots: weighted(
        history.map(x => x.shots)
      ),

      shotsAgainst: weighted(
        history.map(x => x.shotsAgainst)
      ),

      sot: weighted(
        history.map(x => x.sot)
      ),

      sotAgainst: weighted(
        history.map(x => x.sotAgainst)
      ),

      corners: weighted(
        history.map(x => x.corners)
      ),

      cornersAgainst: weighted(
        history.map(x => x.cornersAgainst)
      ),

      poss: weighted(
        history.map(x => x.poss)
      ),

      attacks: weighted(
        history.map(x => x.attacks)
      ),

      crosses: weighted(
        history.map(x => x.crosses)
      ),

      n: history.length
    };
  }

  function adjust(team, opponent, market) {
    const pos =
      (team.poss || 50) -
      (opponent.poss || 50);

    const pressure =
      (team.attacks /
        (opponent.attacks || 1)) -
      1;

    const width =
      (team.crosses /
        (opponent.crosses || 1)) -
      1;

    if (market === "corners") {
      return Math.max(
        -1.2,
        Math.min(
          1.2,
          pos * 0.006 +
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
          pos * 0.004 +
          pressure * 0.8
        )
      );
    }

    return Math.max(
      -1,
      Math.min(
        1,
        pos * 0.003 +
        pressure * 0.5
      )
    );
  }

  function erf(x) {
    const sign =
      x < 0 ? -1 : 1;

    const a = Math.abs(x);

    const t =
      1 /
      (1 + 0.3275911 * a);

    return sign * (
      1 -
      ((((1.061405429 * t - 1.453152027) * t +
        1.421413741) * t -
        0.284496736) * t +
        0.254829592) *
      t *
      Math.exp(-a * a)
    );
  }

  function cdf(z) {
    return 0.5 *
      (1 + erf(z / Math.sqrt(2)));
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

  function predict(fixture, homeHistory, awayHistory) {
    const home =
      profile(homeHistory);

    const away =
      profile(awayHistory);

    const homeShots =
      home.shots * 0.55 +
      away.shotsAgainst * 0.45 +
      adjust(home, away, "shots");

    const awayShots =
      away.shots * 0.55 +
      home.shotsAgainst * 0.45 +
      adjust(away, home, "shots");

    const homeSOT =
      home.sot * 0.55 +
      away.sotAgainst * 0.45;

    const awaySOT =
      away.sot * 0.55 +
      home.sotAgainst * 0.45;

    const homeCorners =
      home.corners * 0.55 +
      away.cornersAgainst * 0.45 +
      adjust(home, away, "corners");

    const awayCorners =
      away.corners * 0.55 +
      home.cornersAgainst * 0.45 +
      adjust(away, home, "corners");

    const lines = [
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

    return lines.map(
      ([market, name, mean, line]) => {
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

        const p =
          over(mean, line, sd);

        const score =
          Math.round(
            Math.max(
              1,
              Math.min(
                95,
                p * 100
              )
            )
          );

        const grade =
          score >= 80
            ? "strong"
            : score >= 70
            ? "value"
            : score >= 62
            ? "watch"
            : "avoid";

        return {
          match:
            `${fixture.home} vs ${fixture.away}`,

          league:
            fixture.league?.name ||
            fixture.league ||
            "Football",

          market,
          name,
          mean,
          line,
          p,
          score,
          grade,

          quality:
            Math.min(
              home.n,
              away.n
            ),

          why:
            `Weighted last-${Math.min(
              Math.min(home.n, away.n),
              20
            )} matches, opponent concession and style pressure.`
        };
      }
    );
  }

  try {
    /*
      STEP 1
      Get today's fixtures.
    */

    const fixtureJson =
      await get(
        `/fixtures/date/${date}`,
        {
          include:
            "participants;league",
          per_page: 50
        }
      );

    const fixtures =
      fixtureJson.data || [];

    /*
      Limit the scan so a Vercel request
      doesn't make too many API calls.
    */

    const selectedFixtures =
      fixtures
        .filter(f => f && f.participants)
        .slice(0, 12);

    const rows = [];

    /*
      STEP 2
      Get approximately six months
      of history for each team.
    */

    for (const fixture of selectedFixtures) {
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
        Get both teams at the same time.
      */

      const [
        homeJson,
        awayJson
      ] = await Promise.all([
        get(
          `/fixtures/between/${start}/${date}/${homeId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50,
            order: "desc"
          }
        ),

        get(
          `/fixtures/between/${start}/${date}/${awayId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50,
            order: "desc"
          }
        )
      ]);

      const fixtureDate =
        new Date(
          fixture.starting_at
        );

      const homeHistory =
        (homeJson.data || [])
          .filter(
            item =>
              new Date(
                item.starting_at
              ) < fixtureDate
          )
          .sort(
            (a, b) =>
              new Date(a.starting_at) -
              new Date(b.starting_at)
          )
          .slice(-20)
          .map(
            item =>
              fixtureToRow(
                item,
                homeId
              )
          );

      const awayHistory =
        (awayJson.data || [])
          .filter(
            item =>
              new Date(
                item.starting_at
              ) < fixtureDate
          )
          .sort(
            (a, b) =>
              new Date(a.starting_at) -
              new Date(b.starting_at)
          )
          .slice(-20)
          .map(
            item =>
              fixtureToRow(
                item,
                awayId
              )
          );

      /*
        We need some historical data
        before producing predictions.
      */

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
      fixtures: selectedFixtures.length,
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
        "Unknown SportMonks API error"
    });
  }
}
