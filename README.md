# Beam: fast, resumable file transfer between computers

Windows ↔ Mac, any direction, over the same Wi-Fi, a direct hotspot, or a cable.
No cloud: files go straight from one disk to the other, encrypted, every block verified,
and big transfers resume after crashes or dropped Wi-Fi.

**Beam 2.0 is a desktop app** (Windows installer, Mac app) with a window, a tray/menu-bar
icon, native file pickers, start-at-login, notifications, and automatic updates that
never interrupt a transfer. The original command-line version still works
(`npm start`) and talks to the desktop app.

## For users
1. Download **Beam-Setup.exe** (Windows) or **Beam.dmg** (Mac) from the Releases page.
2. Install and open it on both computers. On Windows the installer also allows Beam
   through Windows Firewall, so you don't have to.
3. The other computer appears under **Send**. Pick files, press Send, confirm the
   pairing code on both screens the first time.

Closing the window keeps Beam running in the tray/menu bar so it can receive. Quit from
the tray icon. Beam asks first if a transfer is still running.

## Releasing (for the maintainer)
One-time setup:
1. Put this folder in a GitHub repository. In `package.json`, replace
   `YOUR_GITHUB_USERNAME` (in `homepage` and `repository`) with the real owner/repo,
   or auto-update won't find releases.
2. Optional but strongly recommended: add code-signing secrets in GitHub → Settings →
   Secrets and variables → Actions:
   - Mac (Apple Developer Program, $99/year): `MAC_CERT_P12_BASE64` (a "Developer ID
     Application" certificate exported as .p12, base64-encoded), `MAC_CERT_PASSWORD`,
     `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
   - Windows: `WIN_CERT_P12_BASE64`, `WIN_CERT_PASSWORD`. Note: newer Windows
     certificates are issued on hardware tokens or cloud signing services and can't be
     exported as a .p12. If yours is one of those, the Windows signing step must be
     adapted to that provider's signing tool.
   Without secrets the pipeline still builds, but **unsigned**: Mac users must
   right-click → Open, Mac auto-update won't work (Apple requires signed apps), and
   Windows SmartScreen will warn.

Every release:
1. Bump `version` in `package.json` (e.g. 2.0.1), commit.
2. `git tag v2.0.1 && git push --tags`
3. GitHub Actions runs all tests, then builds the Windows installer (x64 + ARM) and
   Mac apps (Apple Silicon + Intel) and uploads them to a **draft** release.
4. Check the draft, then press **Publish**. Installed copies update themselves within
   ~6 hours (or on next launch), never during a transfer.

Developing: `npm install`, then `npm run app` (desktop) or `npm start` (command line).
`npm test` runs the transfer suites; `npm run test:app` drives the real desktop app
(on Linux: `xvfb-run -a npm run test:app`).

## Why not a pure web app?
Browsers can't create hotspots, open raw TCP connections, or accept incoming connections.
That's why ShareIt is an app, and why this is too.

## Speed: what to expect
Speed is set by the link, not the software. The agent moved **~130–300 MB/s** in tests
on a single slow CPU core, so on real hardware the network is the limit:

| Link | Realistic speed | 100 GB takes |
|---|---|---|
| Same home Wi-Fi (via router) | 10–40 MB/s | 45 min – 3 h |
| Direct hotspot, 5 GHz | 30–80 MB/s | 20–55 min |
| Gigabit Ethernet cable | ~110 MB/s | ~15 min |
| Thunderbolt cable, Mac↔Mac | 500 MB/s – 2 GB/s (disk-bound) | 1–4 min |

A hotspot beats router Wi-Fi because data makes one wireless hop instead of two.
For 100 GB, **use a cable** if you possibly can.

**Which cable?** PC↔Mac: an **Ethernet** cable. Use a USB-C-to-Ethernet adapter on any
computer without an Ethernet port. Plug it in and wait ~30 s: both computers give
themselves a 169.254.x.x address automatically, and Beam finds the other one.
Mac↔Mac: a Thunderbolt cable. **A plain USB-C cable between a PC and a Mac does not
create a network.**

## Find your bottleneck (built in)
- **Wi-Fi readout** (Send panel): band, channel, link rate, signal, and the realistic
  maximum for that link. On a Mac joined to the hotspot, this shows the hotspot's real
  band and rate.
- **Test network speed**: 8 seconds memory-to-memory over the real encrypted
  connections, with no disk involved. If a file transfer is much slower than this
  number, a disk is the bottleneck; if they match, the network is.

Why a Windows hotspot is often slow: if the PC is also connected to normal Wi-Fi, one
radio does both jobs and splits its airtime, and Windows may host on 2.4 GHz. Wi-Fi Direct
(how ShareIt gets its phone speeds) doesn't exist between Windows and Mac: Macs don't
support it.

## Command-line version (no installer)
1. Install Node.js 18.15+ from https://nodejs.org on both computers.
2. Copy this folder to both computers.
3. Windows: double-click `start-windows.bat`. Mac: double-click `start-mac.command`
   (first time: right-click → Open, because it's not signed).
4. The control panel opens in your browser. The other computer appears under **Send**
   within a few seconds.

**Firewall (important):**
- **Windows:** the first launch asks whether to allow Node.js; tick **both Private and
  Public networks**. A hotspot or new Wi-Fi is often classed as "Public", and inbound
  transfers are then blocked silently.
- **macOS:** click **Allow** when asked about incoming connections.

Ports: TCP 45455 (transfers) and UDP 45454 (discovery). The control panel is only
reachable from the same computer.

## Using it
1. **Send:** pick the device, tick files or folders in the file browser, press Send.
2. **First time only:** both screens show a 6-digit pairing code. Confirm on both if they
   match. After that the devices trust each other.
3. **Receiver** accepts; files land in `Downloads/Beam` (change it in Settings).
4. **Interrupted?** Wi-Fi drop, sleep, crash, closed program: the sender retries for 15
   minutes by itself. Or just send the same files again later and only the missing
   part is sent; no prompt, because it's recognised as a resume.

### No shared network: hotspot
- **Windows:** "Start hotspot on this PC" shows a network name and a 10-digit password,
  plus live status (on/off, devices connected). On the other computer: Join hotspot →
  **Scan for networks** → click the Beam network → type the password → Join.
- **"Wi-Fi is turned off on this PC"** when starting the hotspot: turn Wi-Fi on. If it
  switches itself off when a cable is plugged in, that's a BIOS feature on many Dell
  laptops ("LAN/WLAN Switching"); unplug the cable or disable that setting.
- **Mac:** can only **join**. Apple offers no API to create a hotspot, so start it on the
  Windows PC. Mac↔Mac: use a Thunderbolt/USB-C cable (both Macs get a "Thunderbolt
  Bridge" network automatically) or enable Internet Sharing manually in System Settings.
- Joining a hotspot disconnects that computer from its current Wi-Fi.

## Troubleshooting

**Mac: "start-mac.command could not be executed because you do not have appropriate
access privileges"**: the file lost its "executable" flag (some download/unzip tools
strip it). Open Terminal, type `chmod +x ` (with a trailing space), drag
`start-mac.command` into the Terminal window, press Enter. Then right-click the file →
**Open** → **Open** (needed once, because it isn't signed by Apple).
Alternative that always works: in Terminal, `cd` into the folder and run `node src/main.js`.

**Windows: "listen EACCES: permission denied 127.0.0.1:7070"** (versions before 1.1):
Windows reserves blocks of ports for Hyper-V/WSL/Docker. Beam 1.1+ automatically moves to
a free port and prints which one. To see the reserved ranges:
`netsh interface ipv4 show excludedportrange protocol=tcp`.

**Mac: "Scan" finds no Beam hotspot / shows hidden names**: since macOS 14.4, apps
without Location Services permission can't read Wi-Fi network names. Type the name shown
on the PC (e.g. `BeamYKJY`) and press Join, or join it from the Wi-Fi icon in the menu
bar. Beam works the same either way.

**The other computer can't see the hotspot at all** (not even in its own Wi-Fi menu):
on the PC press **"Switch to 2.4 GHz"**. Name and password stay the same; 2.4 GHz works
with every device but is slower than 5 GHz.

**Windows: Wi-Fi box shows only the link rate, no band/channel**: recent Windows 11
updates hide Wi-Fi details unless location access is on. Settings → Privacy & security →
Location → turn on "Location services" and "Let desktop apps access your location".

**Started it twice?** The second launch just opens the running copy.

### Doesn't find the other device?
Some networks (hotels, offices, public Wi-Fi) use "client isolation", which blocks all
device-to-device traffic, including this. Use a hotspot or a cable. You can also add a
device manually by IP ("Add it by IP address").

## Security
- **Pairing:** each device has a permanent key. The pairing code is derived from both
  keys, so if anyone intercepts the connection, the codes won't match.
- **Encryption:** X25519 key exchange (fresh keys every session, plus the pairing keys),
  then AES-256-GCM on every frame. Corrupted or tampered data is detected and re-sent.
- **Control panel:** bound to 127.0.0.1, per-launch secret token, Host-header check. Other
  devices and other websites can't use it or browse your files.
- **Received paths are sanitised:** no `..`, no absolute paths, no reserved Windows names.

## Protocol (BTP/1), briefly
- TCP. 6-byte header `BEAM | version | kind`.
- The control connection does the key exchange, then carries encrypted
  INFO / PAIR / OFFER / ACCEPT / END / MISSING / COMPLETE / PROGRESS messages.
- N data connections (default 4) join the session by ID and carry 4 MB blocks, each one
  encrypted and authenticated frame.
- The receiver writes blocks straight into position in a `.beampart` file, flushes and
  records a bitmap of saved blocks every 2 s, and renames the file when it's complete.
  After END, the receiver answers MISSING (with its bitmap) or COMPLETE.
- Disk space is checked before accepting.

## Choosing where files are saved (2.1)
Settings → **Browse…** next to "Save received files to". The desktop app opens the
system folder picker (with New Folder); the command-line version opens Beam's built-in
folder browser. The choice is saved immediately, and Beam first checks that it can
really write there (it creates the folder if needed and refuses files, relative paths,
read-only drives and folders without permission, with the reason shown).

## Dropped connections and resending (2.0.1)
- **Silent Wi-Fi drops are detected in ~20 seconds.** Wi-Fi often drops without telling
  either computer, and the operating system then keeps a dead connection "open" for up
  to ~15 minutes. Both Beams now ping each other every 4 s; 20 s of silence means the
  link is dead, and the sender starts reconnecting and resumes automatically.
- **The retry window is 60 minutes from the last moment data flowed** (it used to count
  from the start of the transfer, so long transfers got no retries at all). After that,
  press **Retry**; it continues where it stopped.
- **Resending files that already arrived skips them** (same size and modified time),
  instead of saving `name (1)` copies in every folder. A file that changed is still
  saved beside the old one as `name (1)`, so nothing is silently overwritten.

## Many small files
Folders with thousands of files (photos, code, documents) now run about 8× faster than
v1.4: on a benchmark of 8,900 files, 5.6 MB/s → 45.6 MB/s (69 → 559 files/s) on the same
machine. The receiver records progress in a tiny checkpoint every 2 s instead of
rewriting the whole file list after every file, flushes finished small files to disk in
parallel batches, and the sender closes each file as soon as it's read (macOS allows only
256 open files by default). `npm run bench` reproduces the measurement.

v1.5.1 also survives running out of file handles. Opening a file waits and retries
instead of failing, and a lookup that used to crash Beam when handles ran out is guarded.
Tested: 20,000 tiny files under a 256-handle limit at 1,133 files/s, never more than 34
open at once. (v1.4 kept every file open and failed with `EMFILE: too many open files`
after ~8,000 files on Windows.)

**Tip for code folders:** `vendor/` and `node_modules/` are often tens of thousands of
files that `composer install` / `npm install` can recreate in seconds. Sending the
project without them is usually much faster.

## Tests
`npm test` runs 12 end-to-end checks with real agent processes (needs ~4 GB free):
discovery, control-panel security, pairing, files + nested folders + empty files, name
clashes, sender killed mid-transfer, receiver killed mid-transfer, a byte flipped on the
wire, rejected pairing, declined offer, and throughput. Last run: `test/last-run.txt`.

## Known limits (read before trusting it with 100 GB)
- **Hotspot code is untested on real hardware.** It was written against the Windows
  Mobile Hotspot API and macOS `networksetup`, but the test machine was Linux. Windows
  may refuse to start a hotspot if the PC has no network connection at all.
- **All tests ran on one machine** over loopback. Real Wi-Fi, real firewalls, and real
  Windows↔Mac paths haven't been exercised yet.
- **Crash recovery keeps what was checkpointed.** A crash loses up to ~2 s of data plus
  whatever was still being flushed; that part is simply re-sent.
- **Parallel connections didn't help on loopback** (1 conn: 296 MB/s, 4 conns: 264 MB/s
  on one CPU core). They help on high-latency or lossy links. Try 1 vs 4 in Settings on
  your own network and keep the faster one.
- **Desktop app: the transfer engine shares the app's main process.** At Wi-Fi speeds
  this costs a few percent of one CPU core, but a very fast transfer on a weak machine
  can make the window and tray icon briefly sluggish. Planned: move the engine into
  its own background process (2.2).
- **Requires Node.js** (command-line version only). There's no signed installer or single .exe/.app yet, and the file
  picker is built into the page rather than the native OS dialog.
