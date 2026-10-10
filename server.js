import 'dotenv/config';
import express from 'express';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrewfatherClient, SAMPLE_BATCHES } from './lib/brewfather.js';
import { discoverDevices, castUrl, stopCasting, deviceStatus } from './lib/cast.js';
import { getScores, getTrivia, getTriviaCategories, LEAGUE_OPTIONS } from './lib/extras.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TAPS_FILE = path.join(__dirname, 'data', 'taps.json');

const brewfather = new BrewfatherClient({
  userId: process.env.BREWFATHER_USER_ID,
  apiKey: process.env.BREWFATHER_API_KEY,
  statuses: (process.env.BREWFATHER_STATUSES || 'Conditioning,Completed').split(',').map((s) => s.trim()).filter(Boolean),
  cacheMinutes: Number(process.env.BREWFATHER_CACHE_MINUTES) || 10,
});

// ---- tap state (persisted to data/taps.json) --------------------------------
// { title: string, taps: [{ tap: number, batchId: string, label?: string }], lastCast: {...} }

// extra: what goes in the spare tile when the tap count is odd.
//   mode: 'info' (rotating scores/trivia/facts, bottom-right) | 'brewery' (name tile, top-left) | 'none'
//   categories: Open Trivia DB category ids; empty = any category.
const DEFAULT_EXTRA = { mode: 'info', breweryName: '', leagues: ['nfl', 'mlb'], trivia: true, categories: [], seconds: 12 };
let state = { title: 'On Tap', taps: [], lastCast: null, defaultDevice: null, extra: { ...DEFAULT_EXTRA } };

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
  if (!brewfather.configured) return { batches: SAMPLE_BATCHES, source: 'sample' };
  const batches = await brewfather.batches({ force });
  return { batches, source: 'brewfather', cacheAgeMs: brewfather.cacheAge() };
}

// Join tap assignments with batch data for the public display.
async function tapList() {
  const { batches, source } = await getBatches();
  const byId = new Map(batches.map((b) => [b.id, b]));
  const taps = state.taps
    .slice()
    .sort((a, b) => a.tap - b.tap)
    .map((t) => ({ tap: t.tap, label: t.label || null, beer: byId.get(t.batchId) ?? null }))
    .filter((t) => t.beer);
  return { title: state.title, taps, extra: state.extra, source, updatedAt: Date.now() };
}

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
  res.json({ ...data, taps: state.taps, title: state.title, displayUrl: displayUrl() });
}));

// Admin: replace tap assignments.
app.put('/api/taps', wrap(async (req, res) => {
  const { taps, title } = req.body ?? {};
  if (!Array.isArray(taps)) return res.status(400).json({ error: 'taps must be an array' });
  const clean = taps
    .filter((t) => t && typeof t.batchId === 'string')
    .map((t, i) => ({ tap: Number(t.tap) || i + 1, batchId: t.batchId, label: t.label ? String(t.label).slice(0, 60) : undefined }));
  state.taps = clean;
  if (typeof title === 'string') state.title = title.slice(0, 80);
  await saveState();
  res.json({ ok: true, taps: state.taps, title: state.title });
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
  };
  await saveState();
  if (state.extra.trivia) getTrivia(state.extra.categories); // warm the cache in the background
  res.json({ ok: true, extra: state.extra });
}));

app.get('/api/extra/content', wrap(async (req, res) => {
  const e = state.extra;
  const scores = e.leagues.length ? await getScores(e.leagues) : [];
  const trivia = e.trivia ? getTrivia(e.categories ?? []) : [];
  res.json({ scores, trivia, seconds: e.seconds });
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
  res.json({ ok: true, brewfather: brewfather.configured ? 'configured' : 'sample-data', displayUrl: displayUrl() }),
);

await loadState();
app.listen(PORT, () => {
  console.log(`brewtoscreen running`);
  console.log(`  Tap list (TV / guests):  ${displayUrl()}`);
  console.log(`  Admin:                   http://localhost:${PORT}/admin.html`);
  console.log(`  Brewfather:              ${brewfather.configured ? 'configured' : 'NOT configured, showing sample data (copy .env.example to .env)'}`);
  console.log(`  Default TV:              ${state.defaultDevice ? state.defaultDevice.name : 'none (set one on the admin page)'}`);

  if (/^(1|true|yes)$/i.test(process.env.CAST_ON_START ?? '') && state.defaultDevice) {
    console.log('  CAST_ON_START is set, casting to the default TV in 5s...');
    setTimeout(() => doCast(state.defaultDevice).catch((err) => console.error('cast on start failed:', err.message)), 5000);
  }
});
