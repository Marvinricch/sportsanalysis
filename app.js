const $ = id => document.getElementById(id);

const state = {
  rows: [],
  fixturesFound: 0,
  fixturesAnalysed: 0
};

const today = new Date();

$("date").value = new Date(
  today.getTime() - today.getTimezoneOffset() * 60000
).toISOString().slice(0, 10);

function normalCDF(z) {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);

  return s * (
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t *
    Math.exp(-a * a)
  );
}

function overProb(mean, line, sd) {
  return Math.max(
    0.01,
    Math.min(
      0.99,
      1 - normalCDF((line - mean) / Math.max(sd, 1))
    )
  );
}

function weighted(values) {
  if (!values.length) return 0;

  let sw = 0;
  let s = 0;

  values.slice(-20).forEach((v, i) => {
    const w = i + 1;
    s += v * w;
    sw += w;
  });

  return sw ? s / sw : 0;
}

function avg(a) {
  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function styleAdjust(team, opp, market) {
  const pos =
    (team.poss || 50) -
    (opp.poss || 50);

  const pressure =
    ((team.attacks || 0) /
      (opp.attacks || 1)) - 1;

  const width =
    ((team.crosses || 0) /
      (opp.crosses || 1)) - 1;

  if (market === "corners") {
    return clamp(
      pos * 0.006 +
      pressure * 0.7 +
      width * 0.35,
      -1.2,
      1.2
    );
  }

  if (market === "shots") {
    return clamp(
      pos * 0.004 +
      pressure * 0.8,
      -1.5,
      1.5
    );
  }

  return clamp(
    pos * 0.003 +
    pressure * 0.5,
    -1,
    1
  );
}

function makeStats(team, opp) {
  const h = team.history || [];
  const o = opp.history || [];

  const shots = weighted(
    h.map(x => x.shots || 0)
  );

  const shotsAgainst = weighted(
    h.map(x => x.shotsAgainst || 0)
  );

  const sot = weighted(
    h.map(x => x.sot || 0)
  );

  const sotAgainst = weighted(
    h.map(x => x.sotAgainst || 0)
  );

  const corners = weighted(
    h.map(x => x.corners || 0)
  );

  const cornersAgainst = weighted(
    h.map(x => x.cornersAgainst || 0)
  );

  const poss = weighted(
    h.map(x => x.poss || 50)
  );

  const attacks = weighted(
    h.map(x => x.attacks || 0)
  );

  const crosses = weighted(
    h.map(x => x.crosses || 0)
  );

  const oppShotsAgainst = weighted(
    o.map(x => x.shotsAgainst || 0)
  );

  const oppSotAgainst = weighted(
    o.map(x => x.sotAgainst || 0)
  );

  const oppCornersAgainst = weighted(
    o.map(x => x.cornersAgainst || 0)
  );

  const oppPoss = weighted(
    o.map(x => x.poss || 50)
  );

  const oppAttacks = weighted(
    o.map(x => x.attacks || 0)
  );

  const oppCrosses = weighted(
    o.map(x => x.crosses || 0)
  );

  const shot =
    shots * 0.55 +
    oppShotsAgainst * 0.45 +
    styleAdjust(
      {
        poss,
        attacks,
        crosses
      },
      {
        poss: oppPoss,
        attacks: oppAttacks,
        crosses: oppCrosses
      },
      "shots"
    );

  const s =
    sot * 0.55 +
    oppSotAgainst * 0.45;

  const cor =
    corners * 0.55 +
    oppCornersAgainst * 0.45 +
    styleAdjust(
      {
        poss,
        attacks,
        crosses
      },
      {
        poss: oppPoss,
        attacks: oppAttacks,
        crosses: oppCrosses
      },
      "corners"
    );

  return {
    shots: shot,
    sot: s,
    corners: cor,
    poss,
    attacks,
    crosses,
    n: h.length
  };
}

function predict(f) {
  const H = makeStats(
    f.home,
    f.away
  );

  const A = makeStats(
    f.away,
    f.home
  );

  const lines = [
    [
      "shots",
      `${f.home.name} shots`,
      H.shots,
      10.5
    ],

    [
      "shots",
      `${f.away.name} shots`,
      A.shots,
      8.5
    ],

    [
      "shots",
      "Match shots",
      H.shots + A.shots,
      24.5
    ],

    [
      "sot",
      `${f.home.name} SOT`,
      H.sot,
      3.5
    ],

    [
      "sot",
      `${f.away.name} SOT`,
      A.sot,
      2.5
    ],

    [
      "sot",
      "Match SOT",
      H.sot + A.sot,
      7.5
    ],

    [
      "corners",
      `${f.home.name} corners`,
      H.corners,
      4.5
    ],

    [
      "corners",
      `${f.away.name} corners`,
      A.corners,
      3.5
    ],

    [
      "corners",
      "Match corners",
      H.corners + A.corners,
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

      const p = overProb(
        mean,
        line,
        sd
      );

      const score = Math.round(
        clamp(
          p * 100,
          1,
          95
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

      const quality =
        Math.min(
          H.n,
          A.n
        ) / 20;

      return {
        match:
          `${f.home.name} vs ${f.away.name}`,

        league:
          f.league || "Football",

        market,
        name,
        mean,
        line,
        p,
        score,
        grade,
        quality,

        why:
          reason(
            market,
            H,
            A
          )
      };
    }
  );
}

function reason(m, H, A) {

  if (m === "corners") {
    return `Corner pressure from creation/concession rates, territorial profile and width. Sample: ${H.n}/${A.n} matches.`;
  }

  if (m === "shots") {
    return `Shot volume blended with opponent shot concession and style pressure. Sample: ${H.n}/${A.n} matches.`;
  }

  return `SOT production blended with opponent SOT allowed and shot efficiency context. Sample: ${H.n}/${A.n} matches.`;
}

function render() {

  let rows = state.rows.filter(
    r =>
      (
        $("market").value === "all" ||
        r.market === $("market").value
      ) &&
      (
        $("grade").value === "all" ||
        r.grade === $("grade").value
      )
  );

  const s = $("sort").value;

  rows.sort(
    (a, b) =>
      s === "prob"
        ? b.p - a.p
        : s === "edge"
        ? (b.p - 0.5) -
          (a.p - 0.5)
        : b.score - a.score
  );

  /*
   * IMPORTANT:
   * Show the actual number of fixtures
   * returned by the API.
   *
   * Previously this was calculated from
   * prediction rows, which could make the
   * dashboard report fewer fixtures than
   * the API actually returned.
   */
  $("fixtureCount").textContent =
    state.fixturesFound ||
    new Set(
      state.rows.map(
        x => x.match
      )
    ).size;

  $("strongCount").textContent =
    rows.filter(
      x => x.grade === "strong"
    ).length;

  $("valueCount").textContent =
    rows.filter(
      x => x.grade === "value"
    ).length;

  $("avgConfidence").textContent =
    rows.length
      ? Math.round(
          avg(
            rows.map(
              x => x.p
            )
          ) * 100
        ) + "%"
      : "—";

  $("empty").style.display =
    rows.length
      ? "none"
      : "block";

  $("cards").innerHTML =
    rows
      .slice(0, 40)
      .map(
        x => `
        <article class="pick">

          <div class="pick-top">

            <div>

              <div class="match">
                ${x.match}
              </div>

              <div class="league">
                ${x.league}
              </div>

            </div>

            <span class="grade ${x.grade}">
              ${x.grade.toUpperCase()}
            </span>

          </div>

          <div class="pick-grid">

            <div class="cell">
              <small>Market</small>
              <b>
                ${x.name} O${x.line}
              </b>
            </div>

            <div class="cell">
              <small>Projection</small>
              <b>
                ${x.mean.toFixed(1)}
              </b>
            </div>

            <div class="cell">
              <small>Probability</small>
              <b>
                ${Math.round(x.p * 100)}%
              </b>
            </div>

            <div class="cell">
              <small>Confidence</small>
              <b class="score">
                ${x.score}
              </b>
            </div>

            <div class="cell">
              <small>Sample</small>
              <b>
                ${Math.round(
                  x.quality * 20
                )}/20
              </b>
            </div>

          </div>

          <div class="why">
            <b>Why:</b>
            ${x.why}
          </div>

        </article>
      `
      )
      .join("");
}


/*
 * Manual demo mode only.
 * It is NOT loaded automatically
 * when the site opens.
 */

function demo() {

  const mk =
    (name, base, opp) =>
      Array.from(
        { length: 20 },
        (_, i) => ({

          shots:
            base +
            (i % 5 - 2),

          shotsAgainst:
            opp +
            (i % 4 - 1),

          sot:
            base * 0.36 +
            (i % 3 - 0.8),

          sotAgainst:
            opp * 0.33 +
            (i % 3 - 0.8),

          corners:
            base * 0.40 +
            (i % 4 - 1),

          cornersAgainst:
            opp * 0.36 +
            (i % 3 - 0.8),

          poss:
            50 +
            (base - opp) * 0.7,

          attacks:
            90 +
            base * 2,

          crosses:
            14 +
            base * 0.5
        })
      );

  const fs = [

    {
      league:
        "Demo Premier",

      home: {
        name:
          "North City",

        history:
          mk(
            "North",
            16,
            10
          )
      },

      away: {
        name:
          "Riverside",

        history:
          mk(
            "River",
            11,
            15
          )
      }
    },

    {
      league:
        "Demo League",

      home: {
        name:
          "United Park",

        history:
          mk(
            "United",
            14,
            12
          )
      },

      away: {
        name:
          "Athletic Club",

        history:
          mk(
            "Athletic",
            12,
            14
          )
      }
    },

    {
      league:
        "Demo Cup",

      home: {
        name:
          "Harbor FC",

        history:
          mk(
            "Harbor",
            10,
            14
          )
      },

      away: {
        name:
          "Metro FC",

        history:
          mk(
            "Metro",
            15,
            10
          )
      }
    }
  ];

  state.rows =
    fs.flatMap(
      predict
    );

  state.fixturesFound =
    fs.length;

  state.fixturesAnalysed =
    fs.length;

  $("status").textContent =
    "Demo data";

  $("statusText").textContent =
    "Model is running locally on sample history.";

  $("statusDot").style.background =
    "var(--yellow)";

  $("updated").textContent =
    new Date().toLocaleTimeString();

  render();
}


async function scan() {

  $("status").textContent =
    "Scanning…";

  $("statusText").textContent =
    "Fetching live fixtures and historical statistics.";

  $("statusDot").style.background =
    "var(--blue)";

  try {

    const date =
      $("date").value;

    const res =
      await fetch(
        `/api/scan?date=${encodeURIComponent(date)}`
      );

    let json = {};

    try {

      json =
        await res.json();

    } catch {

      json = {};

    }

    if (!res.ok) {

      throw new Error(
        json.error ||
        `API request failed with status ${res.status}`
      );
    }

    /*
     * Keep the complete API fixture count
     * separate from prediction rows.
     */
    state.fixturesFound =
      Number(
        json.fixtures || 0
      );

    state.rows =
      json.rows || [];

    /*
     * Count fixtures that actually produced
     * prediction rows.
     */
    state.fixturesAnalysed =
      new Set(
        state.rows.map(
          x => x.match
        )
      ).size;

    $("status").textContent =
      "Live API";

    $("statusText").textContent =
      `Found ${state.fixturesFound} fixtures. Analysed ${state.fixturesAnalysed}.`;

    $("statusDot").style.background =
      "var(--green)";

    $("updated").textContent =
      new Date().toLocaleTimeString();

    render();

  } catch (e) {

    console.error(e);

    $("status").textContent =
      "API error";

    $("statusText").textContent =
      e.message ||
      "Unable to connect to the football API.";

    $("statusDot").style.background =
      "var(--red)";

    $("updated").textContent =
      new Date().toLocaleTimeString();

    state.rows = [];

    state.fixturesFound = 0;

    state.fixturesAnalysed = 0;

    render();
  }
}


$("demoBtn").onclick =
  demo;

$("scanBtn").onclick =
  scan;

$("market").onchange =
  render;

$("grade").onchange =
  render;

$("sort").onchange =
  render;


/*
 * Do NOT call demo() here.
 *
 * The old version had:
 *
 * demo();
 *
 * That was why the site always opened
 * with Demo data.
 */

$("status").textContent =
  "Ready";

$("statusText").textContent =
  "Tap Scan today to fetch live fixtures.";

$("statusDot").style.background =
  "var(--blue)";
