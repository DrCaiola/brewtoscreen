// "Set up a board for someone" from the admin page: find fresh boards on the
// LAN, then over SSH copy the project to one and run deploy/provision-remote.sh.
// Nothing here is logged except what the remote script prints.

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

// ---- LAN scan for SSH servers ----------------------------------------------

function localSubnets() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const base = i.address.split('.').slice(0, 3).join('.');
      if (!out.some((s) => s.base === base)) out.push({ base, self: i.address });
    }
  }
  return out;
}

function probeSsh(host, timeoutMs = 900) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let banner = '';
    let connected = false;
    const done = () => { sock.destroy(); resolve(connected ? { host, banner: banner.split('\n')[0].trim() } : null); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { connected = true; sock.setTimeout(1500); });
    sock.on('data', (d) => { banner += d.toString('latin1'); if (banner.includes('\n')) done(); });
    sock.once('timeout', done);
    sock.once('error', done);
    sock.connect(22, host);
  });
}

export async function scanForBoards() {
  const found = [];
  for (const { base, self } of localSubnets()) {
    const hosts = [];
    for (let n = 1; n < 255; n++) { const h = `${base}.${n}`; if (h !== self) hosts.push(h); }
    const batch = 48;
    for (let i = 0; i < hosts.length; i += batch) {
      const results = await Promise.all(hosts.slice(i, i + batch).map((h) => probeSsh(h)));
      for (const r of results) if (r) found.push(r);
    }
  }
  return found.map((r) => ({
    ...r,
    hint: /dropbear/i.test(r.banner) ? 'Dropbear SSH, probably DietPi'
      : /raspbian|raspberry/i.test(r.banner) ? 'Raspberry Pi OS'
      : /debian|ubuntu/i.test(r.banner) ? 'Debian/Ubuntu (Armbian?)'
      : /openssh/i.test(r.banner) ? 'OpenSSH' : 'SSH',
  })).sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

// ---- provisioning job ------------------------------------------------------

const FILES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIP = ['server.js', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'LICENSE', 'lib', 'public', 'deploy'];

let job = null; // { id, startedAt, log: [], done, ok, error }

export function currentJob() {
  return job ? { id: job.id, startedAt: job.startedAt, log: job.log, done: job.done, ok: job.ok, error: job.error } : null;
}

export function startProvision(opts) {
  if (job && !job.done) throw new Error('A setup is already running. Wait for it to finish.');
  job = { id: Date.now().toString(36), startedAt: Date.now(), log: [], done: false, ok: null, error: null };
  const say = (line) => { job.log.push(line); if (job.log.length > 400) job.log.shift(); };
  runProvision(opts, say)
    .then(() => { job.ok = true; })
    .catch((err) => { job.ok = false; job.error = err.message; say(`!! ${err.message}`); })
    .finally(() => { job.done = true; });
  return job.id;
}

async function listFiles(root, rel, out) {
  const abs = path.join(root, rel);
  const st = await fs.stat(abs);
  if (st.isFile()) { out.push(rel); return; }
  for (const name of await fs.readdir(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    await listFiles(root, path.join(rel, name), out);
  }
}

function connect({ host, user, password }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.once('ready', () => resolve(conn));
    conn.once('error', (err) => reject(new Error(`SSH to ${host} failed: ${err.message}`)));
    conn.connect({ host, port: 22, username: user, password, readyTimeout: 15000, tryKeyboard: true });
    conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => password)));
  });
}

function exec(conn, cmd, onLine) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let buf = '';
      const feed = (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line.trim()) onLine(line); }
      };
      stream.on('data', feed);
      stream.stderr.on('data', feed);
      stream.on('close', (code) => { if (buf.trim()) onLine(buf.trim()); resolve(code ?? 0); });
    });
  });
}

function sftp(conn) {
  return new Promise((resolve, reject) => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
}
const put = (s, local, remote) => new Promise((resolve, reject) => s.fastPut(local, remote, (err) => (err ? reject(err) : resolve())));

const q = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

async function runProvision(o, say) {
  const host = String(o.host ?? '').trim();
  const user = String(o.user ?? 'dietpi').trim() || 'dietpi';
  if (!host) throw new Error('Board address is required.');
  if (!o.password) throw new Error('The board login password is required.');
  if (!/^[a-z0-9-]{0,32}$/i.test(o.hostname ?? '')) throw new Error('Hostname: letters, digits and dashes only.');

  say(`>> connecting to ${user}@${host}`);
  const conn = await connect({ host, user, password: o.password });
  try {
    const home = (await (async () => { let h = ''; await exec(conn, 'echo $HOME', (l) => { h = l; }); return h.trim(); })()) || `/home/${user}`;
    const remoteRoot = `${home}/brewtoscreen`;

    say('>> copying project files');
    const files = [];
    for (const item of SHIP) {
      try { await listFiles(FILES_ROOT, item, files); } catch { /* optional file missing */ }
    }
    const dirs = new Set(files.map((f) => path.posix.dirname(f.split(path.sep).join('/'))).filter((d) => d !== '.'));
    await exec(conn, `mkdir -p ${q(remoteRoot)} ${[...dirs].map((d) => q(`${remoteRoot}/${d}`)).join(' ')} && rm -f ${q(`${remoteRoot}/data/taps.json`)} ${q(`${remoteRoot}/data/settings.json`)}`, say);
    const s = await sftp(conn);
    for (const f of files) {
      await put(s, path.join(FILES_ROOT, f), `${remoteRoot}/${f.split(path.sep).join('/')}`);
    }
    s.end();
    say(`   ${files.length} files copied`);

    say('>> configuring and installing (this takes a few minutes on a fresh board)');
    const args = [o.wifiSsid, o.wifiPsk, o.bfUserId, o.bfApiKey, o.title, o.hostname, o.newPassword].map(q).join(' ');
    const code = await exec(conn, `cd ${q(remoteRoot)} && bash deploy/provision-remote.sh ${args}`, (line) => {
      // never echo secrets back, even if the remote script does
      say(line.replace(o.wifiPsk || '\u0000', '••••').replace(o.bfApiKey || '\u0000', '••••').replace(o.newPassword || '\u0000', '••••'));
    });
    if (code !== 0) throw new Error(`Setup script exited with code ${code}. See the log above.`);
    say('>> all done. Unplug it and hand it over.');
  } finally {
    conn.end();
  }
}
