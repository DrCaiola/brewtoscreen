// Content for the spare tile on the board: live scores (ESPN's public
// scoreboard feed) and trivia (Open Trivia DB). Everything is cached so the
// TV polling every couple of minutes costs little.

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const games = await cached(`scores:${key}`, 30_000, async () => {
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
    // Live games first, then finished, then upcoming; cap per league.
    const rank = { in: 0, post: 1, pre: 2 };
    const sorted = games.slice().sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || new Date(a.date) - new Date(b.date));
    out.push({ league: key, label: league.label, games: sorted.slice(0, 9) });
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

export async function getTriviaCategories() {
  const list = await cached('trivia:categories', 24 * 60 * 60_000, async () => {
    const data = await fetchJson('https://opentdb.com/api_category.php');
    return (data.trivia_categories ?? []).map((c) => ({ id: c.id, name: c.name }));
  });
  return list ?? [];
}

// Open Trivia DB allows one request per category and one request every
// five seconds per IP, so a multi-category refresh runs in the background
// and callers get whatever is cached meanwhile.
const TRIVIA_TTL = 30 * 60_000;
let trivia = { key: '', at: 0, items: [], refreshing: false };

export function getTrivia(categoryIds = []) {
  const ids = [...new Set(categoryIds.map(Number).filter(Boolean))].sort((a, b) => a - b);
  const key = ids.join(',');
  const stale = trivia.key !== key || Date.now() - trivia.at > TRIVIA_TTL;
  if (stale && !trivia.refreshing) refreshTrivia(key, ids);
  return trivia.key === key ? trivia.items : [];
}

async function refreshTrivia(key, ids) {
  trivia.refreshing = true;
  try {
    const targets = ids.length ? ids : [null];
    const perCategory = ids.length ? Math.max(4, Math.ceil(24 / ids.length)) : 24;
    const items = [];
    for (let i = 0; i < targets.length; i++) {
      if (i > 0) await sleep(5200);
      const url = `https://opentdb.com/api.php?amount=${perCategory}&type=multiple${targets[i] ? `&category=${targets[i]}` : ''}`;
      try {
        const data = await fetchJson(url);
        if (data.response_code !== 0) throw new Error(`response_code ${data.response_code}`);
        for (const q of data.results) {
          const choices = [...q.incorrect_answers, q.correct_answer].map(decodeEntities);
          for (let a = choices.length - 1; a > 0; a--) { const b = Math.floor(Math.random() * (a + 1)); [choices[a], choices[b]] = [choices[b], choices[a]]; }
          items.push({
            category: decodeEntities(q.category).replace(/^Entertainment: |^Science: /, ''),
            difficulty: q.difficulty,
            question: decodeEntities(q.question),
            answer: decodeEntities(q.correct_answer),
            choices,
          });
        }
      } catch (err) {
        console.warn(`extras: trivia category ${targets[i] ?? 'any'} failed: ${err.message}`);
      }
    }
    // Interleave categories so the rotation does not run one topic for ages.
    items.sort(() => Math.random() - 0.5);
    if (items.length) trivia = { key, at: Date.now(), items, refreshing: false };
    else trivia = { ...trivia, key, at: Date.now() - TRIVIA_TTL + 60_000, refreshing: false }; // retry in a minute
  } finally {
    trivia.refreshing = false;
  }
}
