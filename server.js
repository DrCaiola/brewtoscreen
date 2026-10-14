import 'dotenv/config';
import express from 'express';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrewfatherClient, SAMPLE_BATCHES } from './lib/brewfather.js';
import { discoverDevices, castUrl, stopCasting, deviceStatus } from './lib/cast.js';
import { getScores, getTrivia, getTriviaCategories, LEAGUE_OPTIONS } from './lib/extras.js';
import { Publisher, toSnapshot } from './lib/publish.js';
import { scanForBoards, startProvision, currentJob } from './lib/provision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TAPS_FILE = path.join(__dirname, 'data', 'taps.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

// Credentials can come from .env or from the admin page's setup form
// (saved to data/settings.json), so nobody has to edit a file by hand.
let settings = {};
try { settings = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')); } catch { /* none yet */ }

function makeBrewfather() {
  return new BrewfatherClient({
    userId: process.env.BREWFATHER_USER_ID || settings.brewfatherUserId,
    apiKey: process.env.BREWFATHER_API_KEY || settings.brewfatherApiKey,
    statuses: (process.env.BREWFATHER_STATUSES || 'Fermenting,Conditioning,Completed').split(',').map((s) => s.trim()).filter(Boolean),
    cacheMinutes: Number(process.env.BREWFATHER_CACHE_MINUTES) || 10,
  });
}
let brewfather = makeBrewfather();

// Optional: push the tap list to a GitHub repo (e.g. the brewery's GitHub Pages site).
// Settings come from .env, or from the admin page (saved in data/settings.json).
// Values saved from the admin page win; .env is the fallback (and the only
// option if nobody ever touches the form).
function publishConfig() {
  const s = settings.publish;
  if (s && (s.repo || s.token)) {
    return { token: s.token || '', repo: s.repo || '', path: s.path || 'taps.json', branch: s.branch || 'main',
      everyHours: s.everyHours ?? 24, siteUrl: s.siteUrl || '', fromEnv: false };
  }
  return {
    token: process.env.PUBLISH_GITHUB_TOKEN || '',
    repo: process.env.PUBLISH_REPO || '',
    path: process.env.PUBLISH_PATH || 'taps.json',
    branch: process.env.PUBLISH_BRANCH || 'main',
    everyHours: process.env.PUBLISH_EVERY_HOURS ?? 24,
    siteUrl: process.env.PUBLISH_SITE_URL || '',
    fromEnv: Boolean(process.env.PUBLISH_REPO),
  };
}
let publisher = new Publisher(publishConfig());

async function saveSettings() {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

// ---- tap state (persisted to data/taps.json) --------------------------------
// { title: string, taps: [{ tap: number, batchId: string, label?: string }], lastCast: {...} }

// extra: what goes in the spare tile when the tap count is odd.
//   mode: 'info' (rotating scores/trivia/facts, bottom-right) | 'brewery' (name tile, top-left) | 'none'
//   categories: Open Trivia DB category ids; empty = any category.
//   scoresEvery: show a scores slide after this many trivia questions; 0 = once per full trivia loop.
//   liveMinutes: when a live game's score changes, cut in with it, at most once per this many minutes; 0 = off.
const DEFAULT_EXTRA = { mode: 'info', breweryName: '', leagues: ['nfl', 'mlb'], trivia: true, categories: [], seconds: 12, scoresEvery: 0, liveMinutes: 2 };
// tapCount + showAll: always draw this many tap slots; unassigned ones show as "Kicked".
// custom: things that are not in Brewfather (seltzer, hopped tea...). Same shape as a batch.
let state = {
  title: 'On Tap', taps: [], tapCount: 7, showAll: true, custom: [],
  lastCast: null, defaultDevice: null, extra: { ...DEFAULT_EXTRA },
};

const CUSTOM_KINDS = {
  seltzer: { label: 'Hard seltzer', style: 'Hard Seltzer', srm: 0 },
  tea: { label: 'Hopped tea', style: 'Hopped Tea', srm: 9 },
  cider: { label: 'Cider', style: 'Cider', srm: 3 },
  other: { label: 'Other', style: '', srm: 5 },
};

async function loadState() {
  try {
    state = { ...state, ...JSON.parse(await fs.readFile(TAPS_FILE, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not read taps.json:', err.message);
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(TAPS_FILE), { recursive: true });
  await fs.writeFile(TAPS_FILE, JSON.stringify(state, null, 2));
}

async function getBatches(force = false) {
  const custom = state.custom.map((c) => ({ ...c, status: 'Custom', custom: true }));
  if (!brewfather.configured) return { batches: [...custom, ...SAMPLE_BATCHES], source: 'sample' };
  const batches = await brewfather.batches({ force });
  return { batches: [...custom, ...batches], source: 'brewfather', cacheAgeMs: brewfather.cacheAge() };
}

// Join tap assignments with batch data for the public display.
async function tapList() {
  const { batches, source } = await getBatches();
  const byId = new Map(batches.map((b) => [b.id, b]));
  const assigned = new Map();
  for (const t of state.taps) {
    const beer = byId.get(t.batchId);
    if (beer) assigned.set(t.tap, { tap: t.tap, label: t.label || null, beer });
  }
  let taps;
  if (state.showAll) {
    const n = Math.max(state.tapCount, ...assigned.keys());
    taps = Array.from({ length: n }, (_, i) => assigned.get(i + 1) ?? { tap: i + 1, label: null, beer: null });
  } else {
    taps = [...assigned.values()].sort((a, b) => a.tap - b.tap);
  }
  return { title: state.title, taps, extra: state.extra, source, siteUrl: publishConfig().siteUrl || null, updatedAt: Date.now() };
}

// The public snapshot for the website, and a debounced publish after edits.
const snapshot = async () => toSnapshot(await tapList());
const publishSoon = () => publisher.schedule(snapshot);

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function displayUrl() {
  return process.env.PUBLIC_URL || `http://${lanAddress()}:${PORT}/`;
}

// ---- web app ---------------------------------------------------------------

const app = express();
app.use(express.json());
// Log page and tap-list requests so you can see the TV/phones pulling data,
// and remember when each client last loaded the board (used to confirm a cast).
const lastPageLoad = new Map(); // ip -> timestamp
app.use((req, res, next) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  if (req.path === '/' || req.path === '/api/taps' || req.path === '/api/cast') {
    console.log(new Date().toLocaleTimeString(), ip, req.method, req.path);
  }
  if (req.path === '/' && req.method === 'GET') lastPageLoad.set(ip, Date.now());
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

// Public: what's on tap right now.
app.get('/api/taps', wrap(async (req, res) => res.json(await tapList())));

// Admin: all candidate batches from Brewfather plus current assignments.
app.get('/api/batches', wrap(async (req, res) => {
  const data = await getBatches(req.query.refresh === '1');
  res.json({ ...data, taps: state.taps, title: state.title, tapCount: state.tapCount, showAll: state.showAll, displayUrl: displayUrl() });
}));

// Admin: replace tap assignments.
app.put('/api/taps', wrap(async (req, res) => {
  const { taps, title, tapCount, showAll } = req.body ?? {};
  if (!Array.isArray(taps)) return res.status(400).json({ error: 'taps must be an array' });
  const clean = taps
    .filter((t) => t && typeof t.batchId === 'string')
    .map((t, i) => ({ tap: Number(t.tap) || i + 1, batchId: t.batchId, label: t.label ? String(t.label).slice(0, 60) : undefined }));
  state.taps = clean;
  if (typeof title === 'string') state.title = title.slice(0, 80);
  if (tapCount !== undefined) state.tapCount = Math.min(12, Math.max(1, Number(tapCount) || 7));
  if (showAll !== undefined) state.showAll = Boolean(showAll);
  await saveState();
  publishSoon();
  res.json({ ok: true, taps: state.taps, title: state.title, tapCount: state.tapCount, showAll: state.showAll });
}));

// First-run setup from the admin page: save Brewfather credentials after testing them.
app.get('/api/setup', (req, res) => {
  res.json({
    configured: brewfather.configured,
    source: process.env.BREWFATHER_USER_ID ? 'env' : settings.brewfatherUserId ? 'settings' : null,
    userId: brewfather.userId ? `${brewfather.userId.slice(0, 4)}…` : null,
  });
});

app.post('/api/setup', wrap(async (req, res) => {
  const userId = String(req.body?.userId ?? '').trim();
  const apiKey = String(req.body?.apiKey ?? '').trim();
  if (!userId || !apiKey) return res.status(400).json({ error: 'Both the User ID and the API key are needed.' });
  const trial = new BrewfatherClient({ userId, apiKey, statuses: ['Completed'], cacheMinutes: 1 });
  try {
    await trial._get('/batches', { limit: 1 });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  settings = { ...settings, brewfatherUserId: userId, brewfatherApiKey: apiKey };
  await saveSettings();
  brewfather = makeBrewfather();
  // Anything that was pointing at sample beers no longer applies.
  state.taps = state.taps.filter((t) => !t.batchId.startsWith('sample-'));
  await saveState();
  res.json({ ok: true, configured: true });
}));

// Custom (non-Brewfather) items.
app.get('/api/custom', (req, res) => res.json({ custom: state.custom, kinds: CUSTOM_KINDS }));

app.post('/api/custom', wrap(async (req, res) => {
  const b = req.body ?? {};
  const kind = CUSTOM_KINDS[b.kind] ? b.kind : 'other';
  const name = String(b.name ?? '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const num = (v, d = null) => (v === '' || v === undefined || v === null || Number.isNaN(Number(v)) ? d : Number(v));
  const item = {
    id: b.id && state.custom.some((c) => c.id === b.id) ? b.id : `custom-${Date.now().toString(36)}`,
    kind,
    name,
    style: String(b.style ?? CUSTOM_KINDS[kind].style).trim().slice(0, 60) || null,
    abv: num(b.abv),
    ibu: num(b.ibu),
    calories: num(b.calories),
    carbs: num(b.carbs),
    srm: num(b.srm, CUSTOM_KINDS[kind].srm),
    notes: String(b.notes ?? '').trim().slice(0, 120) || null,
    addedAt: Date.now(),
  };
  const idx = state.custom.findIndex((c) => c.id === item.id);
  if (idx >= 0) state.custom[idx] = { ...state.custom[idx], ...item };
  else state.custom.unshift(item);
  await saveState();
  publishSoon();
  res.json({ ok: true, item });
}));

app.delete('/api/custom/:id', wrap(async (req, res) => {
  state.custom = state.custom.filter((c) => c.id !== req.params.id);
  state.taps = state.taps.filter((t) => t.batchId !== req.params.id);
  await saveState();
  publishSoon();
  res.json({ ok: true });
}));

// Website publishing (GitHub). GET shows status, POST publishes right now,
// PUT /settings changes the target (token is kept if left blank).
app.get('/api/publish', (req, res) => {
  const c = publishConfig();
  res.json({
    configured: publisher.configured, repo: c.repo || null, path: c.path, branch: c.branch,
    everyHours: Number(c.everyHours) || 0, siteUrl: c.siteUrl || null, hasToken: Boolean(c.token),
    fromEnv: c.fromEnv, url: publisher.url, last: publisher.last,
  });
});

app.put('/api/publish/settings', wrap(async (req, res) => {
  const b = req.body ?? {};
  const repo = String(b.repo ?? '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.status(400).json({ error: 'Repo should look like owner/name.' });
  // Keep the previous token when the field is left blank (settings first, then .env).
  const prev = settings.publish?.token ? settings.publish : { token: process.env.PUBLISH_GITHUB_TOKEN || '' };
  settings.publish = {
    token: String(b.token ?? '').trim() || prev.token || '',
    repo,
    path: String(b.path ?? '').trim().replace(/^\/+/, '') || 'taps.json',
    branch: String(b.branch ?? '').trim() || 'main',
    everyHours: Math.min(168, Math.max(0, Number(b.everyHours) || 0)),
    siteUrl: String(b.siteUrl ?? '').trim().slice(0, 200),
  };
  if (b.clearToken) settings.publish.token = '';
  const next = new Publisher(publishConfig());
  if (next.configured) {
    try { await next.test(); } catch (err) { return res.status(400).json({ error: err.message }); }
  }
  await saveSettings();
  publisher.stop();
  publisher = next;
  if (publisher.configured) { publisher.start(snapshot); publisher.schedule(snapshot, 3000); }
  res.json({ ok: true, configured: publisher.configured });
}));

app.get('/api/publish/preview', wrap(async (req, res) => res.json(await snapshot())));

app.post('/api/publish', wrap(async (req, res) => {
  if (!publisher.configured) return res.status(400).json({ error: 'Publishing is not set up. Add PUBLISH_GITHUB_TOKEN and PUBLISH_REPO to .env.' });
  const result = await publisher.publish(await snapshot(), { force: Boolean(req.body?.force) });
  res.json({ ok: true, ...result, url: publisher.url });
}));

// Set up a board for someone else, over SSH from here (see lib/provision.js).
app.get('/api/provision/scan', wrap(async (req, res) => res.json({ boards: await scanForBoards() })));
app.get('/api/provision/status', (req, res) => res.json({ job: currentJob() }));
app.post('/api/provision', wrap(async (req, res) => {
  const b = req.body ?? {};
  const id = startProvision({
    host: b.host, user: b.user, password: b.password,
    wifiSsid: b.wifiSsid ?? '', wifiPsk: b.wifiPsk ?? '',
    bfUserId: String(b.bfUserId ?? '').trim(), bfApiKey: String(b.bfApiKey ?? '').trim(),
    title: String(b.title ?? '').slice(0, 80), hostname: String(b.hostname ?? '').trim().toLowerCase(),
    newPassword: b.newPassword ?? '',
  });
  res.json({ ok: true, id });
}));

// Spare-tile settings and content.
app.get('/api/extra', wrap(async (req, res) => {
  res.json({ extra: state.extra, leagues: LEAGUE_OPTIONS, triviaCategories: await getTriviaCategories() });
}));

app.put('/api/extra', wrap(async (req, res) => {
  const b = req.body ?? {};
  const mode = ['info', 'brewery', 'none'].includes(b.mode) ? b.mode : state.extra.mode;
  state.extra = {
    mode,
    breweryName: typeof b.breweryName === 'string' ? b.breweryName.slice(0, 60) : state.extra.breweryName,
    leagues: Array.isArray(b.leagues) ? b.leagues.filter((l) => LEAGUE_OPTIONS.some((o) => o.key === l)) : state.extra.leagues,
    trivia: b.trivia === undefined ? state.extra.trivia : Boolean(b.trivia),
    categories: Array.isArray(b.categories) ? b.categories.map(Number).filter(Boolean).slice(0, 12) : (state.extra.categories ?? []),
    seconds: Math.min(60, Math.max(5, Number(b.seconds) || state.extra.seconds)),
    scoresEvery: b.scoresEvery === undefined ? (state.extra.scoresEvery ?? 0) : Math.min(30, Math.max(0, Number(b.scoresEvery) || 0)),
    liveMinutes: b.liveMinutes === undefined ? (state.extra.liveMinutes ?? 2) : Math.min(60, Math.max(0, Number(b.liveMinutes) || 0)),
  };
  await saveState();
  if (state.extra.trivia) getTrivia(state.extra.categories); // warm the cache in the background
  res.json({ ok: true, extra: state.extra });
}));

app.get('/api/extra/content', wrap(async (req, res) => {
  const e = state.extra;
  const scores = e.leagues.length ? await getScores(e.leagues) : [];
  const trivia = e.trivia ? getTrivia(e.categories ?? []) : [];
  res.json({ scores, trivia, seconds: e.seconds, scoresEvery: e.scoresEvery ?? 0, liveMinutes: e.liveMinutes ?? 2 });
}));

// Chromecast.
app.get('/api/cast/devices', wrap(async (req, res) => {
  const devices = await discoverDevices({ timeoutMs: 4000 });
  res.json({ devices, lastCast: state.lastCast, displayUrl: displayUrl() });
}));

app.get('/api/cast/status', wrap(async (req, res) => {
  const host = req.query.host;
  if (!host) return res.status(400).json({ error: 'host is required' });
  res.json(await deviceStatus({ host, port: Number(req.query.port) || 8009 }));
}));

async function doCast({ host, port, name, force, reloadSeconds }) {
  const url = displayUrl();
  const castStarted = Date.now();
  const result = await castUrl({
    host,
    port: Number(port) || 8009,
    url,
    force: force === undefined ? true : Boolean(force),
    reloadSeconds: Number(reloadSeconds) || 0,
    isLoaded: async () => (lastPageLoad.get(host) ?? 0) >= castStarted,
  });
  state.lastCast = { host, port: Number(port) || 8009, name: name ?? host, at: Date.now() };
  await saveState();
  console.log(`cast -> ${name ?? host}: ${result.loaded ? 'loaded' : 'NOT confirmed'} after ${result.attempts} attempt(s)`);
  return result;
}

app.post('/api/cast', wrap(async (req, res) => {
  const { host } = req.body ?? {};
  if (!host) return res.status(400).json({ error: 'host is required' });
  res.json({ ok: true, ...(await doCast(req.body)) });
}));

// Default TV: set from the admin page, used by cast.html, cast-to-tv.cmd and CAST_ON_START.
app.get('/api/cast/default', (req, res) => res.json({ device: state.defaultDevice }));

app.put('/api/cast/default', wrap(async (req, res) => {
  const { host, port, name } = req.body ?? {};
  if (!host) return res.status(400).json({ error: 'host is required' });
  state.defaultDevice = { host, port: Number(port) || 8009, name: name || host };
  await saveState();
  res.json({ ok: true, device: state.defaultDevice });
}));

app.post('/api/cast/default', wrap(async (req, res) => {
  if (!state.defaultDevice) return res.status(400).json({ error: 'No default TV set. Pick one on the admin page.' });
  res.json({ ok: true, device: state.defaultDevice, ...(await doCast(state.defaultDevice)) });
}));
// Same thing as a plain link, handy for phone home-screen bookmarks and smart buttons.
app.get('/go', wrap(async (req, res) => {
  if (!state.defaultDevice) return res.status(400).send('No default TV set. Pick one on /admin.html');
  const r = await doCast(state.defaultDevice);
  res.send(r.loaded ? `${state.defaultDevice.name} is showing the taps.` : 'Sent, but the TV never loaded the page.');
}));

app.post('/api/cast/stop', wrap(async (req, res) => {
  const { host, port } = req.body ?? {};
  if (!host) return res.status(400).json({ error: 'host is required' });
  res.json(await stopCasting({ host, port: Number(port) || 8009 }));
}));

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    brewfather: brewfather.configured ? 'configured' : 'sample-data',
    publish: publisher.configured ? publisher.repo : 'off',
    displayUrl: displayUrl(),
  }),
);

await loadState();
app.listen(PORT, () => {
  console.log(`brewtoscreen running`);
  console.log(`  Tap list (TV / guests):  ${displayUrl()}`);
  console.log(`  Admin:                   http://localhost:${PORT}/admin.html`);
  console.log(`  Brewfather:              ${brewfather.configured ? 'configured' : 'NOT configured, showing sample data (copy .env.example to .env)'}`);
  console.log(`  Default TV:              ${state.defaultDevice ? state.defaultDevice.name : 'none (set one on the admin page)'}`);
  console.log(`  Website:                 ${publisher.configured ? `${publisher.repo}/${publisher.path}, every ${publisher.everyMs / 3600000}h and after edits` : 'off (set PUBLISH_GITHUB_TOKEN and PUBLISH_REPO)'}`);

  if (publisher.configured) {
    publisher.start(snapshot);
    // Catch up on anything that changed while the server was down.
    publisher.schedule(snapshot, 15000);
  }

  if (/^(1|true|yes)$/i.test(process.env.CAST_ON_START ?? '')) {
    console.log('  CAST_ON_START is set, casting to the default TV in 5s...');
    setTimeout(async () => {
      try {
        if (!state.defaultDevice) {
          // No TV chosen yet: if there is exactly one screen on the network, use it.
          const screens = (await discoverDevices({ timeoutMs: 5000 })).filter((d) => d.video);
          if (screens.length === 1) {
            state.defaultDevice = { host: screens[0].host, port: screens[0].port, name: screens[0].name };
            await saveState();
            console.log(`  Only one screen found, using it as the default TV: ${screens[0].name}`);
          } else {
            console.log(`  ${screens.length} screens found; pick one on the admin page.`);
            return;
          }
        }
        await doCast(state.defaultDevice);
      } catch (err) {
        console.error('cast on start failed:', err.message);
      }
    }, 5000);
  }
});
