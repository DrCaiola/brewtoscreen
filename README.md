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
   In the Brewfather app go to **Settings → API** and click **Generate**.
   The dialog shows two values: the **User ID** (a short 28-character string)
   and the **API key**. Copy both. The key is only shown once, and generating
   a new key replaces the old one, so if you closed the dialog without the
   User ID, generate again and copy both. Give the key the **Read Batches**
   scope.
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

## The spare tile

With an odd number of taps one slot on the board is empty. On the admin page
you can fill it with:

- **Rotating info** (bottom-right): live scores for the leagues you tick
  (ESPN's public scoreboard feed) and trivia questions that reveal the answer
  on the next slide (Open Trivia DB). Tick the trivia categories you want, or
  none for a mix of everything.
- **Brewery tile** (top-left): your brewery name in big type.
- Nothing.

Scores are cached for a minute and trivia for half an hour. Open Trivia DB
allows one request every five seconds, so after you change categories the new
questions take about five seconds per category to arrive.

## One button to put it on the TV

On the admin page, scan and click **Make default** next to your TV. Then any
of these casts the board:

- Open <http://localhost:3000/cast.html> (or the same address with your
  computer's LAN IP from a phone) and press the big button. Add it to your
  phone's home screen for a one-tap launcher.
- Double-click `cast-to-tv.cmd`. Make a desktop shortcut to it.
- Hit <http://localhost:3000/go> from anything that can open a URL: a Stream
  Deck button, a Home Assistant automation, a smart button, a Siri/Google
  shortcut.
- Set `CAST_ON_START=true` in `.env` and the server casts five seconds after
  it starts, so a shortcut that runs `npm start` also launches the TV.

## Running it without your desktop

A Chromecast can only be driven from a device on the same network, so some
box on your LAN has to run this. It does not have to be your desktop:

- **A small Linux board (recommended).** A Raspberry Pi Zero 2 W, an Orange
  Pi Zero 2W, or anything similar running Debian, Ubuntu or Armbian on arm64
  runs this comfortably; it idles at a few megabytes of RAM and does nothing
  until you cast. Setup:

  ```bash
  git clone <your repo url> ~/brewtoscreen
  cd ~/brewtoscreen
  bash deploy/install-pi.sh
  nano .env     # add Brewfather credentials, set CAST_ON_START=true if you like
  sudo systemctl restart brewtoscreen@$USER
  ```

  The install script installs Node 22 if needed, installs dependencies, and
  registers a systemd service (`deploy/brewtoscreen.service`) so it starts on
  boot and restarts if it crashes. The board must be on the same Wi-Fi as the
  Chromecast. Give it a DHCP reservation on your router so its address, and
  therefore the URL the TV loads, never changes.

### Orange Pi Zero 2W, step by step from a Windows laptop

You need: the board, a microSD card (8 GB or more), a USB-C power supply
(5V/2A or better), and for the first boot only a mini-HDMI cable to a TV plus
a USB keyboard on a USB-C OTG adapter. The board has no Ethernet, so Wi-Fi
has to be set up once at the keyboard; after that everything is done over SSH
from the laptop.

1. **Flash the card.** Download the Armbian image for the Orange Pi Zero 2W
   from <https://www.armbian.com/orange-pi-zero-2w/> (the minimal/CLI
   Bookworm build is plenty). Write it to the microSD with
   [balenaEtcher](https://etcher.balena.io/) or Rufus.
2. **First boot at the TV.** Insert the card, connect HDMI and keyboard,
   power on. Log in as `root` with password `1234`. Armbian's first-run
   wizard asks you to set a root password and create a normal user (call it
   `brew`). When it asks about networking, pick your Wi-Fi and enter the
   password. If it does not ask, run `nmtui`, choose *Activate a connection*,
   and join your Wi-Fi. Note the IP it gets (`hostname -I`).
3. **Reserve its IP.** In your router (Google Home app for Google Wifi:
   Wi-Fi → Devices → the board → Settings → Reserve IP) reserve that address
   so it never changes.
4. **Copy the project over from the laptop.** In a terminal on this laptop:

   ```bash
   scp -r C:/dev/brewtoscreen/{server.js,package.json,package-lock.json,lib,public,deploy,.env.example,.env,data} brew@<board-ip>:~/brewtoscreen/
   ```

   (Create the folder first with `ssh brew@<board-ip> mkdir -p brewtoscreen`.)
   Or, if you have pushed the repo to GitHub, `ssh` in and
   `git clone <repo url> ~/brewtoscreen` instead.
5. **Install and start.**

   ```bash
   ssh brew@<board-ip>
   cd ~/brewtoscreen
   bash deploy/install-pi.sh
   nano .env        # Brewfather credentials; set CAST_ON_START=true
   sudo systemctl restart brewtoscreen@brew
   ```

6. **Point the TV at the board.** Open `http://<board-ip>:3000/admin.html`
   from any device on the Wi-Fi, scan, and make your TV the default. Unplug
   the keyboard and HDMI; the board can live anywhere with power and Wi-Fi.

To update later, repeat step 4 and `sudo systemctl restart brewtoscreen@brew`.
- **GitHub Pages for the guest page.** The board for guests can live on GitHub
  Pages: a scheduled GitHub Action pulls Brewfather and writes `taps.json`
  into the repo, and the static page reads that. The LAN box is then only
  needed to send the cast command, and it can cast the GitHub Pages URL
  instead of its own. This is not built yet; ask for it if you want it.

What will not work: hosting only on GitHub Pages with no LAN box, because
nothing could talk to the Chromecast, and the Brewfather API key must not be
exposed in a public page.

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
