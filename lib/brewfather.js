// Brewfather v2 API client. Docs: https://docs.brewfather.app/api
// Auth is HTTP Basic with "userId:apiKey". Data comes back in metric units.

const BASE = 'https://api.brewfather.app/v2';

// Fields we pull on top of the defaults (_id, name, batchNo, status, brewer, brewDate, recipe.name).
const INCLUDE = [
  'recipe.style.name',
  'recipe.abv',
  'recipe.ibu',
  'recipe.color',
  'recipe.type',
  'recipe.carbonation',
  'recipe.nutrition',
  'recipe.og',
  'recipe.fg',
  'measuredAbv',
  'measuredOg',
  'measuredFg',
  'estimatedOg',
  'estimatedFg',
  'estimatedIbu',
  'estimatedColor',
  'bottlingDate',
  'batchNotes',
  'img_url',
  'recipe.img_url',
].join(',');

export class BrewfatherClient {
  constructor({ userId, apiKey, statuses, cacheMinutes = 10 }) {
    this.userId = userId;
    this.apiKey = apiKey;
    this.statuses = statuses;
    this.cacheMs = cacheMinutes * 60 * 1000;
    this._cache = { at: 0, batches: null };
  }

  get configured() {
    return Boolean(this.userId && this.apiKey);
  }

  _headers() {
    const token = Buffer.from(`${this.userId}:${this.apiKey}`).toString('base64');
    return { authorization: `Basic ${token}`, accept: 'application/json' };
  }

  async _get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: this._headers() });
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      throw new Error(`Brewfather rate limit hit (500/hour). Retry after ${retry ?? 'a while'} seconds.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Brewfather rejected the credentials. Check BREWFATHER_USER_ID / BREWFATHER_API_KEY and that the key has the Read Batches scope.',
      );
    }
    if (!res.ok) {
      throw new Error(`Brewfather ${res.status} ${res.statusText} for ${url.pathname}`);
    }
    return res.json();
  }

  // Pages through /batches for one status. limit max is 50.
  async _batchesForStatus(status) {
    const all = [];
    let startAfter;
    for (let page = 0; page < 10; page++) {
      const chunk = await this._get('/batches', {
        status,
        include: INCLUDE,
        limit: 50,
        order_by: 'brewDate',
        order_by_direction: 'desc',
        start_after: startAfter,
      });
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      all.push(...chunk);
      if (chunk.length < 50) break;
      startAfter = chunk[chunk.length - 1]._id;
    }
    return all;
  }

  async batches({ force = false } = {}) {
    if (!this.configured) throw new Error('Brewfather credentials are not configured.');
    const fresh = Date.now() - this._cache.at < this.cacheMs;
    if (!force && fresh && this._cache.batches) return this._cache.batches;

    const results = await Promise.all(this.statuses.map((s) => this._batchesForStatus(s)));
    const batches = results.flat().map(normalizeBatch);
    batches.sort((a, b) => (b.brewDate ?? 0) - (a.brewDate ?? 0));
    this._cache = { at: Date.now(), batches };
    return batches;
  }

  cacheAge() {
    return this._cache.at ? Date.now() - this._cache.at : null;
  }
}

// Flatten a Brewfather batch into the shape the display page needs.
export function normalizeBatch(b) {
  const r = b.recipe ?? {};
  const abv = pick(b.measuredAbv, r.abv);
  const og = pick(b.measuredOg, b.estimatedOg, r.og);
  const fg = pick(b.measuredFg, b.estimatedFg, r.fg);
  const ibu = pick(b.estimatedIbu, r.ibu);
  const srm = pick(b.estimatedColor, r.color);
  // Calories/carbs per 12 oz, computed from the batch's own gravities with the
  // standard formulas (measured values when you logged them). Brewfather's
  // recipe nutrition is the fallback; it is reported per 100 ml, so scale it.
  const n = r.nutrition ?? {};
  const computed = nutritionFromGravity(og, fg);
  const calories = pick(computed?.calories, n.calories?.total != null ? n.calories.total * 3.55 : null);
  const carbs = pick(computed?.carbs, n.carbs?.total != null ? n.carbs.total * 3.55 : null);
  // Brewfather names every batch "Batch" unless you rename it, so prefer the
  // recipe name and only use the batch name when it was actually customised.
  const generic = !b.name || /^batch(\s*#?\s*\d+)?$/i.test(b.name.trim());
  return {
    id: b._id,
    name: ((generic ? r.name || b.name : b.name) || 'Unnamed batch').trim(),
    recipeName: r.name ?? null,
    batchNo: b.batchNo ?? null,
    status: b.status ?? null,
    style: r.style?.name ?? null,
    type: r.type ?? null,
    abv: round(abv, 1),
    og: round(og, 3),
    fg: round(fg, 3),
    ibu: round(ibu, 0),
    srm: round(srm, 1),
    calories: round(calories, 0),
    carbs: round(carbs, 1),
    carbonation: round(r.carbonation, 1),
    brewDate: b.brewDate ?? null,
    bottlingDate: b.bottlingDate ?? null,
    notes: b.batchNotes ?? null,
    imageUrl: b.img_url ?? r.img_url ?? null,
  };
}

// Standard beer nutrition estimate (per 12 oz / 355 ml) from OG and FG.
function nutritionFromGravity(og, fg) {
  if (!og || !fg || og <= 1 || fg <= 0.98) return null;
  const plato = (sg) => -616.868 + 1111.14 * sg - 630.272 * sg ** 2 + 135.997 * sg ** 3;
  const oe = plato(og);
  const ae = plato(fg);
  const re = 0.1808 * oe + 0.8192 * ae;              // real extract, °P
  const abw = (oe - re) / (2.0665 - 0.010665 * oe);  // alcohol by weight, %
  const calories = (6.9 * abw + 4.0 * (re - 0.1)) * fg * 3.55;
  const carbs = (re - 0.1) * fg * 3.55;
  return { calories, carbs };
}

function pick(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return v;
  return null;
}

function round(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// Sample data so the UI works before credentials are set up.
export const SAMPLE_BATCHES = [
  {
    _id: 'sample-1', name: 'Porch Swing Pale Ale', batchNo: 12, status: 'Completed',
    brewDate: Date.UTC(2026, 7, 14), bottlingDate: Date.UTC(2026, 8, 2),
    measuredAbv: 5.6, measuredOg: 1.054, measuredFg: 1.011, estimatedIbu: 38, estimatedColor: 6.2,
    recipe: { name: 'Porch Swing Pale Ale', style: { name: 'American Pale Ale' }, type: 'All Grain', carbonation: 2.4 },
  },
  {
    _id: 'sample-2', name: 'Night Shift Stout', batchNo: 13, status: 'Completed',
    brewDate: Date.UTC(2026, 7, 28), bottlingDate: Date.UTC(2026, 8, 20),
    measuredAbv: 6.8, measuredOg: 1.066, measuredFg: 1.015, estimatedIbu: 32, estimatedColor: 38,
    recipe: { name: 'Night Shift Stout', style: { name: 'American Stout' }, type: 'All Grain', carbonation: 2.1 },
  },
  {
    _id: 'sample-3', name: 'Hazy Little Thing Clone', batchNo: 14, status: 'Conditioning',
    brewDate: Date.UTC(2026, 8, 18),
    measuredAbv: 6.5, measuredOg: 1.06, measuredFg: 1.011, estimatedIbu: 45, estimatedColor: 4.5,
    recipe: { name: 'Hazy Little Thing Clone', style: { name: 'Hazy IPA' }, type: 'All Grain', carbonation: 2.5 },
  },
  {
    _id: 'sample-4', name: 'Oktoberfest', batchNo: 11, status: 'Completed',
    brewDate: Date.UTC(2026, 5, 6), bottlingDate: Date.UTC(2026, 7, 1),
    measuredAbv: 5.9, measuredOg: 1.056, measuredFg: 1.011, estimatedIbu: 24, estimatedColor: 11,
    recipe: { name: 'Oktoberfest', style: { name: 'Festbier' }, type: 'All Grain', carbonation: 2.6 },
  },
  {
    _id: 'sample-5', name: 'Backyard Pilsner', batchNo: 10, status: 'Completed',
    brewDate: Date.UTC(2026, 4, 2), bottlingDate: Date.UTC(2026, 5, 20),
    measuredAbv: 4.9, measuredOg: 1.048, measuredFg: 1.009, estimatedIbu: 35, estimatedColor: 3.2,
    recipe: { name: 'Backyard Pilsner', style: { name: 'German Pilsner' }, type: 'All Grain', carbonation: 2.7 },
  },
  {
    _id: 'sample-6', name: 'Red Barn Amber', batchNo: 9, status: 'Completed',
    brewDate: Date.UTC(2026, 3, 11), bottlingDate: Date.UTC(2026, 4, 1),
    measuredAbv: 5.4, measuredOg: 1.052, measuredFg: 1.012, estimatedIbu: 28, estimatedColor: 16,
    recipe: { name: 'Red Barn Amber', style: { name: 'American Amber Ale' }, type: 'All Grain', carbonation: 2.4 },
  },
  {
    _id: 'sample-7', name: 'Double Trouble DIPA', batchNo: 8, status: 'Completed',
    brewDate: Date.UTC(2026, 2, 20), bottlingDate: Date.UTC(2026, 3, 12),
    measuredAbv: 8.4, measuredOg: 1.078, measuredFg: 1.014, estimatedIbu: 72, estimatedColor: 7,
    recipe: { name: 'Double Trouble DIPA', style: { name: 'Double IPA' }, type: 'All Grain', carbonation: 2.3 },
  },
].map(normalizeBatch);
