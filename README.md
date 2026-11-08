# Discord Stay Voice

A minimal Discord self-bot that only logs in and stays connected to voice

> [!WARNING]
> **Risks of Using a Self-Bot**
> Using a user account (self-bot) for automation violates the
> [Discord Terms of Service](https://discord.com/terms) and can get your
> account permanently banned. Use it at your own risk.

> [!IMPORTANT]
> This project is built on `discord.js-selfbot-v13`, which is licensed under
> **GPL-3.0**. This project is therefore subject to the same license.

## Local Setup

```bash
npm ci
export DISCORD_TOKEN=YOUR_DISCORD_TOKEN
export VOICE_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID
npm start
```

The bot joins the voice channel after logging in and tries to rejoin if the
connection drops.

## Custom Rich Presence

This repository supports Custom Rich Presence configured through `.env`. It
is enabled automatically once the selfbot logs in successfully.

```env
RPC_ENABLED=true
RPC_APPLICATION_ID=123456789012345678
RPC_NAME=My Custom RPC
RPC_DETAILS=Playing on Discord
RPC_STATE=Indonesia
RPC_LARGE_IMAGE=
RPC_LARGE_TEXT=
RPC_SMALL_IMAGE=
RPC_SMALL_TEXT=
RPC_BUTTON1_NAME=
RPC_BUTTON1_URL=
RPC_BUTTON2_NAME=
RPC_BUTTON2_URL=
RPC_START_TIMESTAMP=true
```

What each variable does:

* `RPC_ENABLED` — enables/disables RPC.
* `RPC_APPLICATION_ID` — the ID of the Discord application used by Rich Presence.
* `RPC_NAME` — activity name.
* `RPC_DETAILS` — activity details.
* `RPC_STATE` — additional state/status line.
* `RPC_LARGE_IMAGE` — large image asset.
* `RPC_LARGE_TEXT` — large image tooltip.
* `RPC_SMALL_IMAGE` — small image asset.
* `RPC_SMALL_TEXT` — small image tooltip.
* `RPC_BUTTON1_NAME` — label of the first button.
* `RPC_BUTTON1_URL` — URL of the first button.
* `RPC_BUTTON2_NAME` — label of the second button.
* `RPC_BUTTON2_URL` — URL of the second button.
* `RPC_START_TIMESTAMP` — when `true`, shows elapsed time since RPC was enabled.

Full configuration example:

```env
RPC_ENABLED=true
RPC_APPLICATION_ID=123456789012345678
RPC_NAME=My Custom RPC
RPC_DETAILS=Playing Discord
RPC_STATE=Online
RPC_LARGE_IMAGE=
RPC_LARGE_TEXT=My Large Image
RPC_SMALL_IMAGE=
RPC_SMALL_TEXT=My Small Image
RPC_BUTTON1_NAME=GitHub
RPC_BUTTON1_URL=https://github.com
RPC_BUTTON2_NAME=Website
RPC_BUTTON2_URL=https://example.com
RPC_START_TIMESTAMP=true
```

### How to get an Application ID

The Application ID comes from the
[Discord Developer Portal](https://discord.com/developers/applications):
create or select an application, then copy the **Application ID** from the
General Information page.

An Application ID is **NOT**:

* a Discord User ID
* a Server/Guild ID
* a Channel ID
* a Discord token

Never share or expose a Discord token in documentation, public
configuration, or source code.

### Image Assets

Rich Presence images use assets attached to the Discord application you are
using (`RPC_APPLICATION_ID`). Upload the image on the application page in the
Developer Portal (Rich Presence / Art Assets), then set `RPC_LARGE_IMAGE` or
`RPC_SMALL_IMAGE` to the asset name or ID. `RPC_LARGE_TEXT` and
`RPC_SMALL_TEXT` become tooltips when the cursor hovers over the image.
Empty fields are skipped.

The `RichPresence` implementation used by this project also supports the
following image formats:

* application asset ID (17–19 digit number)
* `cdn.discordapp.com` / `media.discordapp.net` URL
* media proxy (`mp:...`, `external/...`)
* `youtube:...`, `spotify:...`, `twitch:...`

For external image URLs, there is an existing API:

```js
const { RichPresence } = require('./src/index.js');

// Up to 2 valid URLs, returns external assets via the Discord API.
const assets = await RichPresence.getExternal(client, applicationId, imageUrl1, imageUrl2);
```

Invalid assets are skipped with a warning, and RPC keeps running without an
image.

### Buttons

At most 2 buttons can be used. Each button requires a complete pair:

* name (`RPC_BUTTON1_NAME` / `RPC_BUTTON2_NAME`)
* valid URL (`RPC_BUTTON1_URL` / `RPC_BUTTON2_URL`)

If a pair is incomplete or the URL is invalid, that button is skipped (with a
warning) and will not appear. Validation is handled by
`RichPresence.setButtons()`.

### Timestamp

If `RPC_START_TIMESTAMP=true`, the timestamp is created once when RPC is
enabled and the elapsed time is based on that timestamp (Discord calculates
it, with no refresh interval).

### Disabling RPC

```env
RPC_ENABLED=false
```

Voice functionality keeps running when RPC is disabled or the RPC
configuration is incomplete (for example, an empty `RPC_APPLICATION_ID`).
RPC failures do not stop the voice connection.

### Example output

An idea of the status text that appears (the exact rendering in Discord may
differ depending on the client and the Discord API):

```text
My Custom RPC
Playing Discord
Online

[elapsed time]

[GitHub] [Website]
```

> [!NOTE]
> This project uses a selfbot/user account, and using a selfbot may conflict
> with the Discord Terms of Service.

## Multi Account

A single Node.js process can run multiple Discord accounts at the same time.
Each account has its own `Client`, so login, RPC, and voice channel run
independently. If one account fails, the others keep running.

### How to enable multi-account

1. Copy the configuration template:

   ```bash
   cp bot/accounts.example.json bot/accounts.json
   ```

2. Fill `bot/accounts.json` with the token and configuration for each account.

3. Run as usual:

   ```bash
   npm start
   ```

If `bot/accounts.json` exists, the app runs in **multi-account mode**. If the
file does not exist, the app automatically uses **single-account mode** (the
old `.env` configuration: `DISCORD_TOKEN`, `VOICE_CHANNEL_ID`, `RPC_*`).

### Configuration format

`bot/accounts.json` contains an array; each object is one account:

```json
[
  {
    "name": "account1",
    "token": "ACCOUNT_1_TOKEN",
    "voiceChannelId": "VOICE_CHANNEL_ID_1",
    "rpc": {
      "enabled": true,
      "applicationId": "APPLICATION_ID_1",
      "name": "Account 1 Custom RPC",
      "details": "Playing",
      "state": "Online",
      "largeImage": "",
      "largeText": "",
      "smallImage": "",
      "smallText": "",
      "button1Name": "",
      "button1Url": "",
      "button2Name": "",
      "button2Url": "",
      "startTimestamp": true
    }
  },
  {
    "name": "account2",
    "token": "ACCOUNT_2_TOKEN",
    "voiceChannelId": "VOICE_CHANNEL_ID_2",
    "rpc": {
      "enabled": true,
      "applicationId": "APPLICATION_ID_2",
      "name": "Account 2 Custom RPC",
      "details": "Another Activity",
      "state": "Indonesia",
      "largeImage": "",
      "largeText": "",
      "smallImage": "",
      "smallText": "",
      "button1Name": "",
      "button1Url": "",
      "button2Name": "",
      "button2Url": "",
      "startTimestamp": true
    }
  }
]
```

* `name` — account name used as the log prefix (`[ACCOUNT: account1]`). Must
  be unique.
* `token` — the Discord account token. Required; accounts with an empty token
  are skipped.
* `voiceChannelId` — the voice channel for that account. May be empty (voice
  is skipped for that account; it does **NOT** fall back to
  `VOICE_CHANNEL_ID` in `.env`). Each account can use a different channel,
  and two accounts may use the same channel.
* `rpc` — the Rich Presence configuration for that account (optional). The
  fields are the same as the `RPC_*` variables in the Custom Rich Presence
  section. Each account has its own RPC and timestamp, which do not get mixed
  up.
* `stream` — the screenshare / Go Live configuration for that account
  (optional). See the Screenshare (Go Live) section.

Do not put real tokens in the README, issues, or commits.

### Screenshare (Go Live)

An account can light up the **LIVE** badge in a voice channel (Go Live /
screenshare), not just a "Streaming" RPC status on the profile. It loops a
video from a file, so no screen capture is needed.

Requirement: `ffmpeg` must be available in `PATH` (e.g.
`sudo apt-get install -y ffmpeg`). Without ffmpeg, screenshare is skipped and
the account still joins voice as usual.

```json
{
  "name": "account1",
  "token": "TOKEN",
  "voiceChannelId": "VOICE_CHANNEL_ID",
  "stream": {
    "enabled": true,
    "source": "/path/to/video.mp4",
    "fps": 5,
    "bitrate": 100
  }
}
```

* `enabled` — must be `true` to turn on screenshare.
* `source` — path to a local video file or a URL (`http(s)`) that ffmpeg can
  read.
* `fps` — send frame rate, clamped to `1..30`. Default `10`. Lower is cheaper
  on CPU.
* `bitrate` — video bitrate in kbps, clamped to `1..8000`. Default `200`.
* `restartDelayMs` — initial delay before an automatic restart when the
  encoder stops (default `5000`, doubles on each attempt, capped at 10
  attempts).

Notes:

* One `ffmpeg` process per streaming account. Video-only (no audio) is much
  lighter: 480p @ 5 fps is around 1-2% CPU and ~60 MB RAM. 720p30 is not
  recommended on a 1 GB VPS.
* The video loops automatically (`-stream_loop -1 -re`), so use a short clip.
* If the `ffmpeg` process dies (missing file, OOM kill, decode error), the
  stream restarts automatically with backoff, limited to `10` attempts. After
  that it gives up and only writes errors to the log until voice rejoins.
* Screenshare turns back on when voice rejoins / the watchdog reconnects, and
  is shut down when voice disconnects or the bot shuts down (no lingering
  ffmpeg process).
* Real verification is in the log: `Cek badge LIVE: self_stream=true`. This
  value comes from Discord's `VOICE_STATE_UPDATE`, not a local guess.
* To get just the purple "Streaming" status on the profile (no media), use
  `rpc.type: "STREAMING"` + `rpc.url` — that is not this screenshare feature.

### How to go back to single-account mode

Delete or rename `bot/accounts.json`, then make sure `.env` contains
`DISCORD_TOKEN`, `VOICE_CHANNEL_ID`, and (optionally) `RPC_*`:

```bash
mv bot/accounts.json bot/accounts.json.bak
npm start
```

### Running multi-account on Render (Secret File)

On Render you do not need to commit `bot/accounts.json`. Use a Secret File:

1. In the Render Dashboard, open the service → **Environment → Secret Files →
   Add Secret File**.
2. Filename:

   ```text
   accounts.json
   ```

3. Contents (fill in each account's configuration):

   ```json
   [
     {
       "name": "account1",
       "token": "YOUR_DISCORD_TOKEN",
       "voiceChannelId": "YOUR_VOICE_CHANNEL_ID",
       "rpc": {
         "enabled": true,
         "applicationId": "YOUR_APPLICATION_ID",
         "name": "Custom RPC",
         "details": "",
         "state": "",
         "largeImage": "",
         "largeText": "",
         "smallImage": "",
         "smallText": "",
         "button1Name": "",
         "button1Url": "",
         "button2Name": "",
         "button2Url": "",
         "startTimestamp": true
       }
     }
   ]
   ```

4. Redeploy. The app detects the secret file automatically (searched in
   order at `bot/accounts.json`, `accounts.json` in the service root, then
   `/etc/secrets/accounts.json`) and runs in multi-account mode.

`accounts.json` contains tokens, so it **must not be committed to Git** (the
file is already in `.gitignore`; only `bot/accounts.example.json` is
committed, as a template).

### Security

* `bot/accounts.json` contains tokens and **is already in `.gitignore`** —
  it will not be committed. Only `bot/accounts.example.json` is committed, as
  a template.
* Tokens are never printed to the log (even when login fails, only the error
  message appears, without the token).

> [!WARNING]
> Using selfbots / user token automation may violate the Discord Terms of
> Service. Each account that runs is the responsibility of its owner; a
> failure or penalty on one account does not technically affect the others,
> but every account carries the same risk.

## Deploying to Render

1. Connect the repository to Render as a Web Service.
2. Use **Build Command** `npm ci`.
3. Use **Start Command** `npm start`.
4. Add the following environment variables:
   - `DISCORD_TOKEN`: the Discord account token.
   - `VOICE_CHANNEL_ID`: the target voice channel ID.
   - `RPC_*` variables (optional, see the Custom Rich Presence section).
   - For multi-account, use the `accounts.json` Secret File or provide a
     `bot/accounts.json` file (see the Multi Account section).

A health check is available on port `PORT` (default `3000`), listening on
`127.0.0.1` by default:

* `GET /health` — readiness: `200` if at least one account is logged in
  (ready), `503` if none are. The JSON body contains per-account status
  (without credentials).
* `GET /health/live` — liveness: always `200` while the process is alive.
* Other routes return `404`.
* If `HEALTH_TOKEN` is set, every request must include an
  `Authorization: Bearer <token>` header (`401` otherwise).
* The health server never opens without authentication: `HOST=0.0.0.0`
  (non-loopback) is only used when `HEALTH_TOKEN` is set — otherwise the
  server stays bound to `127.0.0.1` with a warning in the log.
* Account status reflects real conditions: a temporary gateway disconnect →
  `reconnecting` (back to `ready` once recovered; drops to `error` if not
  recovered within 60 seconds), a permanently dead gateway or invalid
  session → `error` immediately.

## License

GPL-3.0
