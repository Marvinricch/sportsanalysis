export default async function handler(req, res) {
  const token = process.env.SPORTMONKS_TOKEN;

  if (!token) {
    return res.status(500).json({
      error: "SPORTMONKS_TOKEN is missing from Vercel Production."
    });
  }

  const requestedDate =
    String(req.query.date || new Date().toISOString().slice(0, 10));

  const base = "https://api.sportmonks.com/v3/football";

  async function get(path, params = {}) {
    const url = new URL(base + path);

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, 15000);

    try {
      const response = await fetch(url, {
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
        throw new Error(
          `SportMonks ${response.status}: ${
            data.message ||
            data.error ||
            text ||
            "Request failed"
          }`
        );
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          `SportMonks request timed out: ${path}`
        );
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function participant(fixture, side) {
    const participants = fixture.participants || [];

    return (
      participants.find(
        p =>
          String(
            p.meta?.location ||
            p.location ||
            ""
          ).toLowerCase() === side
      ) ||
      null
    );
  }

  function teamId(fixture, side) {
    const p = participant(fixture, side);

    return (
      p?.id ||
      p?.team_id ||
      p?.participant_id ||
      null
    );
  }

  function teamName(fixture, side) {
    const p = participant(fixture, side);

    if (p?.name) return p.name;

    const parts = String(
      fixture.name || ""
    ).split(" vs ");

    return (
      side === "home"
        ? parts[0]
        : parts[1]
    ) || side;
  }

  function statNumber(stat) {
    const raw =
      stat?.data?.value ??
      stat?.value ??
      stat?.data;

    const number = Number(raw);

    return Number.isFinite(number)
      ? number
      : 0;
  }

  function findStat(stats, names, location) {
    const wanted = names.map(x =>
      x.toLowerCase()
    );

    const found = (stats || []).find(stat => {
      const typeName = String(
        stat.type?.name ||
        stat.type?.developer_name ||
        stat.type ||
        ""
      ).toLowerCase();

      if (
        !wanted.some(name =>
          typeName.includes(name)
        )
      ) {
        return false;
      }

      const statLocation = String(
        stat.location ||
        stat.meta?.location ||
        ""
      ).toLowerCase();

      return !location ||
        statLocation === location;
    });

    return found
      ? statNumber(found)
      : 0;
  }

  function convertFixture(fixture, wantedTeamId) {
    const homeId = teamId(
      fixture,
      "home"
    );

    const side =
      String(homeId) === String(wantedTeamId)
        ? "home"
        : "away";

    const opponent =
      side === "home"
        ? "away"
        : "home";

    const stats =
      fixture.statistics || [];

    return {
      date: fixture.starting_at,

      shots: findStat(
        stats,
        ["shots"],
        side
      ),

      shotsAgainst: findStat(
        stats,
        ["shots"],
        opponent
      ),

      sot: findStat(
        stats,
        [
          "shots on target",
          "shots on goal"
        ],
        side
      ),

      sotAgainst: findStat(
        stats,
        [
          "shots on target",
          "shots on goal"
        ],
        opponent
      ),

      corners: findStat(
        stats,
        ["corners"],
        side
      ),

      cornersAgainst: findStat(
        stats,
        ["corners"],
        opponent
      ),

      poss: findStat(
        stats,
        ["possession"],
        side
      ),

      attacks: findStat(
        stats,
        [
          "attacks",
          "dangerous attacks"
        ],
        side
      ),

      crosses: findStat(
        stats,
        ["crosses"],
        side
      )
    };
  }

  function average(values) {
    const valid = values.filter(
      x => Number.isFinite(x)
    );

    if (!valid.length) return 0;

    return (
      valid.reduce(
        (a, b) => a + b,
        0
      ) / valid.length
    );
  }

  function weighted(values) {
    const valid = values.filter(
      x => Number.isFinite(x)
    );

    if (!valid.length) return 0;

    let total = 0;
    let weights = 0;

    valid
      .slice(-20)
      .forEach((value, index) => {
        const weight = index + 1;

        total += value * weight;
        weights += weight;
      });

    return weights
      ? total / weights
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

  function adjustment(team, opponent, market) {
    const possession =
      (team.poss || 50) -
      (opponent.poss || 50);

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

    return sign * (
      1 -
      ((((1.061405429 * t -
        1.453152027) * t +
        1.421413741) * t -
        0.284496736) * t +
        0.254829592) *
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
    return Math.max(
      0.01,
      Math.min(
        0.99,
        1 -
          normalCDF(
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
    const home =
      profile(homeHistory);

    const away =
      profile(awayHistory);

    const homeShots =
      home.shots * 0.55 +
      away.shotsAgainst * 0.45 +
      adjustment(
        home,
        away,
        "shots"
      );

    const awayShots =
      away.shots * 0.55 +
      home.shotsAgainst * 0.45 +
      adjustment(
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
      adjustment(
        home,
        away,
        "corners"
      );

    const awayCorners =
      away.corners * 0.55 +
      home.cornersAgainst * 0.45 +
      adjustment(
        away,
        home,
        "corners"
      );

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

        const probability =
          overProbability(
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
            "Football",

          market,
          name,
          mean,
          line,

          p: probability,
          score,
          grade,

          quality:
            Math.min(
              home.n,
              away.n
            ),

          why:
            `Weighted historical data from up to 20 previous matches, opponent concessions and playing style.`
        };
      }
    );
  }

  try {
    /*
      First try the date selected
      by the user.
    */

    let fixtureData =
      await get(
        `/fixtures/date/${requestedDate}`,
        {
          include:
            "participants;league",
          per_page: 50
        }
      );

    let fixtures =
      fixtureData.data || [];

    /*
      If there are no fixtures on the
      selected date, check the next
      three dates.

      This prevents the dashboard from
      appearing broken on quiet football
      days.
    */

    if (!fixtures.length) {
      for (let i = 1; i <= 3; i++) {
        const nextDate =
          new Date(
            `${requestedDate}T12:00:00Z`
          );

        nextDate.setUTCDate(
          nextDate.getUTCDate() + i
        );

        const dateString =
          nextDate
            .toISOString()
            .slice(0, 10);

        const nextData =
          await get(
            `/fixtures/date/${dateString}`,
            {
              include:
                "participants;league",
              per_page: 50
            }
          );

        if (
          (nextData.data || []).length
        ) {
          fixtures =
            nextData.data;

          break;
        }
      }
    }

    /*
      Do not make hundreds of API calls.
    */

    const selectedFixtures =
      fixtures
        .filter(
          fixture =>
            fixture &&
            fixture.participants
        )
        .slice(0, 12);

    /*
      If SportMonks genuinely returned
      no fixtures, tell the frontend
      exactly that.
    */

    if (!selectedFixtures.length) {
      return res.status(200).json({
        date: requestedDate,
        fixtures: 0,
        rows: [],
        message:
          "SportMonks returned no fixtures for the selected date or the following three days."
      });
    }

    const rows = [];

    for (
      const fixture
      of selectedFixtures
    ) {
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

      const fixtureTime =
        new Date(
          fixture.starting_at
        );

      const startDate =
        new Date(
          fixtureTime.getTime() -
          180 *
          24 *
          60 *
          60 *
          1000
        )
          .toISOString()
          .slice(0, 10);

      const endDate =
        fixtureTime
          .toISOString()
          .slice(0, 10);

      const [
        homeData,
        awayData
      ] = await Promise.all([
        get(
          `/fixtures/between/${startDate}/${endDate}/${homeId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50,
            order: "desc"
          }
        ),

        get(
          `/fixtures/between/${startDate}/${endDate}/${awayId}`,
          {
            include:
              "participants;statistics.type",
            per_page: 50,
            order: "desc"
          }
        )
      ]);

      const homeHistory =
        (homeData.data || [])
          .filter(
            item =>
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
            item =>
              convertFixture(
                item,
                homeId
              )
          );

      const awayHistory =
        (awayData.data || [])
          .filter(
            item =>
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
            item =>
              convertFixture(
                item,
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
      date: requestedDate,
      fixtures:
        selectedFixtures.length,
      rows
    });

  } catch (error) {
    console.error(
      "SportMonks error:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "SportMonks API request failed."
    });
  }
}
