// Content for the spare tile on the board: live scores (ESPN's public
// scoreboard feed), trivia (Open Trivia DB) and a built-in list of beer facts.
// Everything is cached so the TV polling every couple of minutes costs little.

const LEAGUES = {
  nfl: { label: 'NFL', path: 'football/nfl' },
  cfb: { label: 'College Football', path: 'football/college-football' },
  mlb: { label: 'MLB', path: 'baseball/mlb' },
  nba: { label: 'NBA', path: 'basketball/nba' },
  nhl: { label: 'NHL', path: 'hockey/nhl' },
  cbb: { label: 'College Basketball', path: 'basketball/mens-college-basketball' },
  mls: { label: 'MLS', path: 'soccer/usa.1' },
  epl: { label: 'Premier League', path: 'soccer/eng.1' },
};
export const LEAGUE_OPTIONS = Object.entries(LEAGUES).map(([key, l]) => ({ key, label: l.label }));

const cache = new Map(); // key -> { at, value }
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`extras: ${key} failed: ${err.message}`);
    return hit?.value ?? null; // stale beats nothing
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// ---- scores ----------------------------------------------------------------

export async function getScores(leagueKeys) {
  const out = [];
  for (const key of leagueKeys) {
    const league = LEAGUES[key];
    if (!league) continue;
    const games = await cached(`scores:${key}`, 60_000, async () => {
      const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard`);
      return (data.events ?? []).map((ev) => {
        const comp = ev.competitions?.[0] ?? {};
        const teams = (comp.competitors ?? []).map((c) => ({
          abbr: c.team?.abbreviation ?? '',
          name: c.team?.shortDisplayName ?? c.team?.displayName ?? '',
          score: c.score ?? '',
          home: c.homeAway === 'home',
          logo: c.team?.logo ?? null,
          record: c.records?.[0]?.summary ?? null,
          winner: Boolean(c.winner),
        }));
        const home = teams.find((t) => t.home) ?? teams[0];
        const away = teams.find((t) => !t.home) ?? teams[1];
        return {
          id: ev.id,
          date: ev.date,
          state: ev.status?.type?.state ?? 'pre', // pre | in | post
          detail: ev.status?.type?.shortDetail ?? '',
          away,
          home,
        };
      });
    });
    if (!games) continue;
    // Live games first, then finished today, then upcoming; cap per league.
    const rank = { in: 0, post: 1, pre: 2 };
    const sorted = games.slice().sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || new Date(a.date) - new Date(b.date));
    out.push({ league: key, label: league.label, games: sorted.slice(0, 6) });
  }
  return out;
}

// ---- trivia ----------------------------------------------------------------

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&eacute;/g, 'é').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü').replace(/&auml;/g, 'ä')
    .replace(/&ntilde;/g, 'ñ').replace(/&rsquo;/g, '’').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export async function getTrivia() {
  return cached('trivia', 30 * 60_000, async () => {
    const data = await fetchJson('https://opentdb.com/api.php?amount=20&type=multiple');
    if (data.response_code !== 0) throw new Error(`trivia response_code ${data.response_code}`);
    return data.results.map((q) => {
      const choices = [...q.incorrect_answers, q.correct_answer].map(decodeEntities);
      for (let i = choices.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [choices[i], choices[j]] = [choices[j], choices[i]]; }
      return {
        category: decodeEntities(q.category).replace(/^Entertainment: |^Science: /, ''),
        difficulty: q.difficulty,
        question: decodeEntities(q.question),
        answer: decodeEntities(q.correct_answer),
        choices,
      };
    });
  });
}

// ---- beer facts ------------------------------------------------------------

export const BEER_FACTS = [
  'Hops are a cousin of cannabis. Both belong to the plant family Cannabaceae.',
  'The oldest known beer recipe is a 3,900-year-old Sumerian hymn to Ninkasi, the goddess of brewing.',
  'IBU stands for International Bitterness Units. Most people cannot taste a difference above about 100.',
  'Original gravity measures how much sugar is in the wort before fermentation. More sugar, more potential alcohol.',
  'A "lager" is any beer fermented cold with bottom-fermenting yeast. "Ale" yeast works warm and rises to the top.',
  'Pilsner was first brewed in 1842 in Plzeň, in what is now the Czech Republic, and it was the first pale lager.',
  'The foam on a beer is called the head. Proteins from the malt and compounds from the hops hold it together.',
  'SRM, the beer color scale, runs from about 2 (pale straw) to over 40 (black as night).',
  'The German Reinheitsgebot of 1516 limited beer ingredients to water, barley and hops. Yeast was not yet understood.',
  'Guinness is served with nitrogen instead of carbon dioxide, which is why the bubbles are tiny and the pour cascades.',
  'The word "IPA" comes from pale ales shipped from England to India in the 1700s, hopped heavily to survive the voyage.',
  'A standard US homebrew batch is five gallons, which fills about 53 twelve-ounce bottles.',
  'Yeast produces carbon dioxide and alcohol in roughly equal amounts by weight during fermentation.',
  'A "cicerone" is to beer what a sommelier is to wine.',
  'Cenosillicaphobia is the fear of an empty glass.',
  'The longest recorded beer head stayed up for over an hour. Most last a few minutes.',
  'Belgian Trappist beers are brewed inside monastery walls under the supervision of monks. Only about a dozen exist.',
  'Dry hopping adds hops after the boil, so you get aroma without extra bitterness.',
  'Final gravity tells you how much sugar the yeast left behind. Lower means drier.',
  'The bubbles rising in your glass are nucleating on tiny scratches and dust specks in the glass.',
  'Beer is about 90 to 95 percent water, which is why water chemistry matters so much to brewers.',
  'Lambic beers are fermented by wild yeast and bacteria that drift in from the air around Brussels.',
  'Hop cones contain lupulin glands, the yellow powder that holds the oils and acids brewers want.',
  'A "growler" is a 64-ounce jug for carrying draft beer home. The name may come from the grumbling sound of escaping CO2.',
  'A keg at 38°F and about 12 psi is the sweet spot for most ales and lagers on tap.',
];
