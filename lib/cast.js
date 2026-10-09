// Chromecast control. Discovers devices over mDNS and launches the DashCast
// receiver (a public Cast app that loads any URL in a frame).
//
// DashCast app id and namespace are the ones pychromecast/catt use:
//   https://github.com/home-assistant-libs/pychromecast/blob/master/pychromecast/controllers/dashcast.py

import util from 'node:util';
import { createRequire } from 'node:module';
import { Bonjour } from 'bonjour-service';

const require = createRequire(import.meta.url);
const castv2 = require('castv2-client');
const { Client, Application, RequestResponseController } = castv2;

export const DASHCAST_APP_ID = '84912283';
const DASHCAST_NAMESPACE = 'urn:x-cast:com.madmod.dashcast';

// castv2-client instantiates controllers with Function.apply, so these must be
// old-style constructor functions rather than ES classes.
function DashCastController(client, sourceId, destinationId) {
  RequestResponseController.call(this, client, sourceId, destinationId, DASHCAST_NAMESPACE);
}
util.inherits(DashCastController, RequestResponseController);

DashCastController.prototype.load = function load(url, { force = false, reloadSeconds = 0 } = {}) {
  const reload = !force && reloadSeconds > 0;
  const msg = { url, force, reload, reload_time: reload ? reloadSeconds * 1000 : 0 };
  // DashCast does not reliably answer, so fire and forget.
  this.send(msg);
};

function DashCast(client, session) {
  Application.call(this, client, session);
  this.dash = this.createController(DashCastController);
}
util.inherits(DashCast, Application);
DashCast.APP_ID = DASHCAST_APP_ID;

DashCast.prototype.close = function close() {
  this.dash.close();
  this.dash = null;
  Application.prototype.close.call(this);
};

// ---- discovery -------------------------------------------------------------

export function discoverDevices({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = new Map();
    const browser = bonjour.find({ type: 'googlecast' }, (svc) => {
      const txt = svc.txt ?? {};
      const host = svc.referer?.address ?? (svc.addresses ?? []).find((a) => a.includes('.'));
      if (!host) return;
      // "ca" is a capability bitmask; bit 0 means the device has video output.
      const ca = Number(txt.ca) || 0;
      found.set(svc.fqdn ?? host, {
        name: txt.fn ?? svc.name,
        model: txt.md ?? null,
        host,
        port: svc.port ?? 8009,
        video: (ca & 1) === 1,
      });
    });
    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }, timeoutMs);
  });
}

// ---- casting ---------------------------------------------------------------

function connect(host, port = 8009) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`Timed out connecting to Chromecast at ${host}:${port}`));
    }, 8000);
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    client.connect({ host, port }, () => {
      clearTimeout(timer);
      resolve(client);
    });
  });
}

function getStatus(client) {
  return new Promise((resolve, reject) =>
    client.getStatus((err, status) => (err ? reject(err) : resolve(status))),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors what catt does: DashCast stops listening once it has loaded a page,
// so always stop any running DashCast session and launch a fresh one, then send
// the URL with force=true (top-level navigation, which also sidesteps the
// receiver's mixed-content restrictions on plain-http LAN pages).
//
// The DashCast receiver takes a variable amount of time to boot and start
// listening (messages sent too early are silently dropped), so the URL is
// re-sent every couple of seconds until `isLoaded()` reports that the device
// fetched the page, or until the retry window runs out.
export async function castUrl({
  host,
  port = 8009,
  url,
  force = true,
  reloadSeconds = 0,
  isLoaded = null,
  maxWaitMs = 30000,
}) {
  const client = await connect(host, port);
  try {
    const status = await getStatus(client);
    const running = (status.applications ?? []).find((a) => a.appId === DASHCAST_APP_ID);
    if (running) {
      await new Promise((resolve) => client.receiver.stop(running.sessionId, () => resolve()));
      await sleep(1500);
    }

    const app = await new Promise((resolve, reject) =>
      client.launch(DashCast, (err, a) => (err ? reject(err) : resolve(a))),
    );

    const started = Date.now();
    let attempts = 0;
    let loaded = false;
    while (Date.now() - started < maxWaitMs) {
      app.dash.load(url, { force, reloadSeconds });
      attempts++;
      await sleep(2500);
      if (isLoaded && (await isLoaded())) {
        loaded = true;
        break;
      }
      if (!isLoaded && attempts >= 6) break;
    }
    return { relaunched: Boolean(running), url, attempts, loaded: isLoaded ? loaded : null };
  } finally {
    client.close();
  }
}

export async function stopCasting({ host, port = 8009 }) {
  const client = await connect(host, port);
  try {
    const status = await getStatus(client);
    const apps = (status.applications ?? []).filter((a) => !a.isIdleScreen);
    for (const a of apps) {
      await new Promise((resolve) => client.receiver.stop(a.sessionId, () => resolve()));
    }
    return { stopped: apps.length };
  } finally {
    client.close();
  }
}

export async function deviceStatus({ host, port = 8009 }) {
  const client = await connect(host, port);
  try {
    const status = await getStatus(client);
    const app = (status.applications ?? []).find((a) => !a.isIdleScreen);
    return {
      app: app ? { id: app.appId, name: app.displayName, status: app.statusText } : null,
      dashcast: Boolean(app && app.appId === DASHCAST_APP_ID),
      volume: status.volume?.level ?? null,
    };
  } finally {
    client.close();
  }
}
