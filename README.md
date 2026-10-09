# brewtoscreen

Pulls your finished batches from Brewfather, lets you pick which ones are on tap,
and shows the tap list on a Chromecast and on a web page for guests.

```
Brewfather API  ──▶  brewtoscreen (Node server on your PC/Pi)
                        ├── /admin.html   pick taps, cast to TV
                        ├── /             tap list page (TV + phones)
                        └── Cast protocol ──▶ Chromecast running DashCast ──▶ loads /
```

## Setup

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. In this folder run:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in your Brewfather credentials.
   In the Brewfather app go to **Settings → API**, enable the API, copy your
   **User ID**, and generate an API key with the **Read Batches** scope.
4. Start it:

   ```bash
   npm start
   ```

5. Open <http://localhost:3000/admin.html>. Tick the batches that are on tap,
   give them tap numbers, and click **Save taps**.
6. Click **Scan for devices**, then **Cast tap list** next to your TV.

Without credentials the app runs with sample beers so you can try the UI.

## How the Chromecast part works

A Chromecast cannot open a URL by itself; it only runs Cast "receiver apps".
brewtoscreen launches **DashCast**, a public receiver app that loads whatever URL
it is sent, and points it at this server's tap list page on your LAN
(for example `http://192.168.1.50:3000/`). The server talks to the Chromecast
directly over the Cast protocol, so no browser tab or screen mirroring is involved.

Things to know:

- The Chromecast must be on the same network as this computer and be able to
  reach it on the port in `.env`. Allow Node through Windows Firewall when asked.
- Each cast restarts DashCast and loads the page directly on the TV (the
  same approach the `catt` tool uses). Once loaded, the TV keeps the page and
  refreshes its data every minute on its own, so you only need to cast again
  if something else took over the TV. **Frame mode** in the admin page is the
  alternative DashCast mode; in testing, Chromecasts refused to show a plain
  http LAN page inside the frame, so it is off by default.
- If your computer's LAN IP changes, set `PUBLIC_URL` in `.env` to a fixed
  address or give the computer a DHCP reservation on your router.
- Casting ends if someone casts something else to the TV. Just cast again.

## Web page for guests

Anyone on your Wi-Fi can open the same address the TV uses. To share it beyond
your network, put it behind something like Tailscale Funnel or a Cloudflare
Tunnel, which gives you an HTTPS address without opening ports on your router.

## Files

- `server.js` - Express server, tap state, API routes
- `lib/brewfather.js` - Brewfather v2 client with caching (API limit: 500 calls/hour)
- `lib/cast.js` - Chromecast discovery (mDNS) and DashCast launching
- `public/index.html` - the tap list board
- `public/admin.html` - admin page
- `data/taps.json` - your saved tap assignments (created on first save)
