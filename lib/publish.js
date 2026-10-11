// Publish the tap list as a JSON file in a GitHub repo (for a static site
// such as GitHub Pages). Uses the GitHub contents API, so the box running
// brewtoscreen needs no git install, only a fine-grained token with
// "Contents: read and write" on the one target repo.

const API = 'https://api.github.com';

export class Publisher {
  constructor({ token, repo, path = 'taps.json', branch = 'main', everyHours = 24, log = console.log }) {
    this.token = token;
    this.repo = repo;
    this.path = path.replace(/^\/+/, '');
    this.branch = branch;
    this.everyMs = Math.max(0, Number(everyHours) || 0) * 60 * 60 * 1000;
    this.log = log;
    this.last = null; // { at, ok, skipped, error, sha }
    this._timer = null;
    this._interval = null;
    this._inflight = null;
  }

  get configured() {
    return Boolean(this.token && this.repo && /^[\w.-]+\/[\w.-]+$/.test(this.repo));
  }

  get url() {
    return this.configured ? `https://github.com/${this.repo}/blob/${this.branch}/${this.path}` : null;
  }

  _headers() {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'brewtoscreen',
      'content-type': 'application/json',
    };
  }

  async _request(method, url, body) {
    const res = await fetch(url, { method, headers: this._headers(), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404 && method === 'GET') return null;
    if (res.status === 401) throw new Error('GitHub rejected the token. Check PUBLISH_GITHUB_TOKEN (it may have expired).');
    if (res.status === 403) {
      throw new Error(`GitHub refused (403). The token needs "Contents: read and write" on ${this.repo}.`);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message ?? ''; } catch { /* ignore */ }
      throw new Error(`GitHub ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  async _current() {
    const url = `${API}/repos/${this.repo}/contents/${encodeURI(this.path)}?ref=${encodeURIComponent(this.branch)}`;
    const file = await this._request('GET', url);
    if (!file) return { sha: null, json: null };
    let json = null;
    try { json = JSON.parse(Buffer.from(file.content ?? '', 'base64').toString('utf8')); } catch { /* not JSON */ }
    return { sha: file.sha, json };
  }

  // Push `snapshot` to the repo. Skips the commit when the taps have not
  // changed (everything except updatedAt is compared). Concurrent calls
  // share one request.
  async publish(snapshot, { force = false } = {}) {
    if (!this.configured) throw new Error('Publisher is not configured (PUBLISH_GITHUB_TOKEN and PUBLISH_REPO).');
    if (this._inflight) return this._inflight;
    this._inflight = this._publish(snapshot, force).finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _publish(snapshot, force) {
    const at = Date.now();
    try {
      const { sha, json } = await this._current();
      if (!force && json && stable(json) === stable(snapshot)) {
        this.last = { at, ok: true, skipped: true, sha };
        return this.last;
      }
      const content = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8').toString('base64');
      const url = `${API}/repos/${this.repo}/contents/${encodeURI(this.path)}`;
      const names = snapshot.taps.filter((t) => t.beer).map((t) => t.beer.name).join(', ') || 'nothing on tap';
      const body = { message: `Update tap list: ${names}`.slice(0, 200), content, branch: this.branch, ...(sha ? { sha } : {}) };
      const result = await this._request('PUT', url, body);
      this.last = { at, ok: true, skipped: false, sha: result.content?.sha ?? null, commit: result.commit?.sha ?? null };
      this.log(`published ${this.path} to ${this.repo} (${names})`);
      return this.last;
    } catch (err) {
      this.last = { at, ok: false, error: err.message };
      this.log(`publish failed: ${err.message}`);
      throw err;
    }
  }

  // Publish a few seconds after the last change, so a burst of edits in the
  // admin page becomes one commit. `getSnapshot` is called when the timer fires.
  schedule(getSnapshot, delayMs = 5000) {
    if (!this.configured) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      Promise.resolve().then(getSnapshot).then((s) => this.publish(s)).catch(() => { /* logged in _publish */ });
    }, delayMs);
    this._timer.unref?.();
  }

  // Also republish on a fixed interval so Brewfather-side edits (a measured
  // ABV, a renamed batch) reach the site without touching the admin page.
  start(getSnapshot) {
    if (!this.configured || !this.everyMs) return;
    clearInterval(this._interval);
    this._interval = setInterval(() => {
      Promise.resolve().then(getSnapshot).then((s) => this.publish(s)).catch(() => { /* logged in _publish */ });
    }, this.everyMs);
    this._interval.unref?.();
  }
}

// What the public site gets: title, taps and a timestamp. Spare-tile
// settings, cast state and anything else stay on the LAN.
export function toSnapshot(tapList) {
  return {
    title: tapList.title,
    taps: tapList.taps.map((t) => ({
      tap: t.tap,
      label: t.label ?? null,
      beer: t.beer ? publicBeer(t.beer) : null,
    })),
    updatedAt: tapList.updatedAt ?? Date.now(),
  };
}

function publicBeer(b) {
  return {
    name: b.name,
    style: b.style ?? null,
    abv: b.abv ?? null,
    ibu: b.ibu ?? null,
    srm: b.srm ?? null,
    calories: b.calories ?? null,
    carbs: b.carbs ?? null,
    notes: (typeof b.notes === 'string' && b.notes.trim()) || null,
    custom: Boolean(b.custom),
    kind: b.custom ? b.kind ?? 'other' : null,
    brewDate: b.brewDate ?? null,
  };
}

// Canonical string of a snapshot without its timestamp, for change detection.
function stable(snapshot) {
  const { updatedAt, ...rest } = snapshot ?? {};
  return JSON.stringify(rest, Object.keys(flatten(rest)).sort());
}

function flatten(obj, out = {}) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { out[k] = true; flatten(v, out); }
  }
  return out;
}
