# StreamLoop

A simple personal studio: upload a video, paste a YouTube stream key, and stream from a server. Inspired by the supplied StreamAdda screen, without accounts, billing, or subscriptions in the app.

**Bhai, browser band kar sakte ho. Streaming jis computer/server par chal rahi hai, woh on rehna chahiye.** A VPS lets you switch off your own laptop too. A server has not been rented or deployed as part of this project.

## Pehle local par chalao

Install Node.js 22.12+ (Node 24 recommended), then in this folder:

```powershell
npm install
npm run dev
```

Open **http://localhost:5173**. The API runs on port 3000. Leave the terminal and computer running. FFmpeg and FFprobe are installed automatically through optional platform packages; if those are unavailable, install both on PATH or set `FFMPEG_PATH` / `FFPROBE_PATH` in `.env` and restart.

For a single production process:

```powershell
npm run build
npm start
```

Open **http://localhost:3000**. The frontend and API are now served by the same Node process. No Vite server is needed.

## YouTube par kaise live karna hai

1. Open [YouTube Studio](https://studio.youtube.com) → **Create → Go live → Stream**. First enable live streaming on your channel; first-time activation can take up to 24 hours.
2. Create your broadcast there. Choose the title, description, audience, and public/unlisted/private visibility. The app's stream name is only a local label.
3. Copy the **stream key** into this app. Use a new key if an old one was shared or appeared in a screenshot.
4. Upload a video and wait for upload **and processing** to finish. Select 720p or 1080p. Enable **Loop video** to repeat indefinitely, or turn it off for one playback. An optional end time stops the encoder at that time, using the timezone shown in the UI.
5. Click **Start streaming**. In YouTube Studio, wait for the preview, then click **Go live** if auto-start is off. Enable auto-start in YouTube if you want subsequent encoder starts to go live unattended.
6. Once the preview/broadcast is working, close YouTube and this app if you want. The server keeps sending the video.
7. **Stop stream** stops this app's encoder. To end the YouTube broadcast itself, use **End stream** in YouTube Studio, or configure YouTube's auto-stop. Keeping auto-stop off can allow a temporary encoder disconnection to recover without immediately ending the broadcast.

The app reports **Sending to YouTube** when FFmpeg produces output. It cannot read your channel's actual public/live status without YouTube OAuth/API access. Always confirm the first preview in YouTube Studio. [YouTube's encoder guide](https://support.google.com/youtube/answer/2907883?hl=en) explains the YouTube side.

## Yeh background mein kaise chalta hai?

### YouTube link se source video

In **Stream setup → Your video**, choose **YouTube link**, paste a public recorded video URL, add your destination stream key, and click **Start streaming**. The default **Direct stream — no file saved** mode resolves YouTube's media address and feeds the video and audio straight into FFmpeg. It does not download the entire video or create a library file before starting. A short connection/buffering delay is normal, and internet data is still used for every playback. Closing the browser does not stop the backend; the computer/server and its internet connection must stay on.

With direct mode, looping opens a fresh connection from the beginning after the video finishes; a brief pause can occur. Connection retries and server restarts resolve a fresh address because YouTube media links expire. No signed media URLs are saved to settings, returned to the browser, or written into activity messages. Check the broadcast preview in YouTube Studio; direct mode does not create a local playable preview.

For a saved copy and seamless local looping, choose **Download first — save a copy**. This optional mode downloads and checks the video, creates a library preview, and then starts the encoder automatically. Download progress is shown in the studio; **Cancel preparation** stops it. Closing the browser after Start does not cancel server-side preparation.

For a new local installation, enable this feature once:

```sh
npm run setup:youtube
```

Restart the app afterward. The installer downloads the official platform-specific yt-dlp release into `.tools/youtube/` and verifies its published SHA-256 checksum. Node 22+ provides the downloader's JavaScript runtime. Docker installs the downloader as part of its image build. To use an existing installation, set `YT_DLP_PATH` to its executable in `.env`. Run the setup command again to update the downloader if YouTube changes its delivery format.

Supported links include `youtube.com/watch`, `youtu.be`, Shorts, and completed `/live/` video links. Tracking and playlist parameters are removed; only one video is imported. Currently-live broadcasts, scheduled streams, private/member-only videos, and videos requiring account/age verification are not supported. YouTube may block a download even when a video plays in your signed-in browser; the app reports the error and you can use a local video file instead. Use content you have permission to rebroadcast.

In **Download first** mode, imported videos count toward the same file/storage limits as uploads and appear in **Video library**. A saved copy is reused on future starts, loops, reconnects, and server restarts. Changing the link imports a different video; deleting its cached library file makes the next start download it again. Downloading needs temporary room for video/audio tracks and the merged file, so available disk space can reduce the maximum import size. Direct mode bypasses these disk/storage limits and always reads from YouTube, even if the same video was previously saved. Both modes select sources up to 1080p, with output encoding controlled by the normal 720p/1080p setting.

### Streaming from the saved video

```text
Browser                      Your always-on server                  YouTube
   │                                │                                  │
   ├──── upload video ─────────────► stored video                        │
   ├──── Start streaming ──────────► Node starts FFmpeg                  │
   │                                ├── H.264 + AAC over RTMPS ───────► live
   ╳ browser / laptop closed        ├── repeat video ──────────────────► live
                                    ├── repeat video ──────────────────► live
```

The browser uploads the entire file to persistent server storage first. Node launches FFmpeg independently of browser requests. FFmpeg reads that server file in real time, scales it to 720p or 1080p, adds silence if it has no audio, and sends it to YouTube's fixed RTMPS ingest endpoint. Looping happens inside FFmpeg, rather than in a browser video player. The UI preview only plays your uploaded source file.

The encoder uses 30 fps, H.264, AAC stereo, and a 2-second keyframe interval. The 720p preset is 4 Mbps video; 1080p is 6 Mbps video, plus 128 Kbps audio. See [YouTube's encoder settings](https://support.google.com/youtube/answer/2853702?hl=en).

## Online hosting: Ubuntu VPS + Docker

You need an always-on Linux VPS, persistent disk, and internet upload capacity. As an initial sizing target for one stream, try **2 vCPU, 4 GB RAM, and 30–50 GB disk**, then check real encoding performance; demanding 1080p sources can need more CPU. The UI's Stream activity includes errors; an encoder speed persistently below `1x` indicates insufficient resources.

Continuous streaming uses substantial outbound bandwidth: approximately **45 GB/day at the 720p preset** or **67 GB/day at 1080p**, before protocol overhead (roughly 1.35 TB / 2 TB per 30-day month). Check your VPS bandwidth allowance. Server hosting is a separate cost; the app itself has no billing.

### Option A — no domain, simplest private access

1. Install Docker Engine and the Compose plugin using the [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
2. Copy this project to your VPS, excluding `node_modules`, `.env`, `data`, `.git`, `.npm-cache`, and `.tools`. Alternatively, clone your own repository containing the source.
3. In the project folder on the VPS, run:

   ```sh
   docker compose up -d --build
   ```

4. On your own computer, open an SSH tunnel:

   ```sh
   ssh -N -L 3000:127.0.0.1:3000 YOUR_USER@YOUR_SERVER_IP
   ```

5. Open **http://localhost:3000**, upload the video, and start streaming. You can close the tunnel, browser, and laptop afterward. The detached Docker container keeps running on the VPS. Reopen the tunnel whenever you want to control it.

This needs no app login, domain, or public admin page. Port 3000 is bound only to the VPS's loopback interface. Do not change it to `0.0.0.0:3000:3000` without access protection.

### Option B — open it through your own domain

1. Point a domain/subdomain's DNS A record to the VPS IPv4 address. Use a direct DNS record; remove an incorrect AAAA record if the server has no IPv6. Allow inbound ports **80 and 443** and keep SSH access. YouTube RTMPS uses outbound port 443.
2. Copy `.env.example` to `.env` on the VPS. Generate one browser password hash:

   ```sh
   docker run --rm -it caddy:2-alpine caddy hash-password
   ```

   Enter a strong password at the prompt. Add these settings to `.env`:

   ```dotenv
   SITE_ADDRESS=stream.yourdomain.com
   ADMIN_PASSWORD_HASH='$2a$14$paste_the_complete_generated_hash_here'
   ```

   Keep the **single quotes** around the hash so Docker Compose preserves its dollar signs. This is a single browser password, with username **admin**; there is no registration, user database, or app login flow.

3. Start the app and HTTPS proxy:

   ```sh
   docker compose --profile public up -d --build
   ```

4. Open **https://stream.yourdomain.com**, replacing the example domain with yours. Caddy obtains HTTPS certificates automatically when DNS and the ports are correct. Your browser asks for username `admin` and the password you chose. Upload and start streaming.

Keep the default loopback-only mapping on port 3000. All public access should go through Caddy's HTTPS/password protection. Caddy requires a real password hash; a missing hash fails closed. See [Caddy basic authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth).

## Restart, reconnect, and stopping

- `docker compose up -d` runs independently of your SSH terminal. The container restarts after a crash or host reboot unless you explicitly stop it. Docker must itself be enabled on boot.
- Uploads, thumbnails, settings, the encrypted stream key, and resume intent persist in the `streamloop_data` Docker volume. Do not remove the volume or use `docker compose down -v` if you need to keep them.
- On a broken connection, the app retries up to 10 times with an increasing delay, capped at 60 seconds. An encoder that makes no progress for 60 seconds is restarted. After a stable connection lasting a minute, the retry count can reset.
- A server restart resumes an active stream **from the beginning of the selected video**. Reconnection also restarts from the beginning. This is recovery, not guaranteed uninterrupted delivery; an ended YouTube broadcast may need to be opened or created again.
- A saved end time is honored by the backend even with every browser closed. An already expired end time prevents resuming after restart. Clear or change an old time before starting a new stream.
- Clicking **Stop stream** clears resume intent. `docker compose stop` stops the whole app; starting it again resumes previously active intent. Stop the stream in the app first if you want it to stay stopped.
- One stream can run at a time. Stop it before changing its video/key/settings. Uploading additional library videos is possible while streaming.

Check the server:

```sh
docker compose ps
docker compose logs --tail=100 app
```

Stream diagnostics appear in **Stream activity** in the UI, with keys and ingest URLs removed. The key is encrypted using AES-256-GCM; the encryption key is stored in the same persistent volume with restricted file permissions. Back up the complete volume together and treat it as private. Encryption here protects against accidentally reading the state JSON, not someone who controls your server.

## Files and configuration

| File | Purpose |
| --- | --- |
| `src/App.jsx`, `src/styles.css` | React studio and responsive UI |
| `server/app.mjs` | Uploads, library, settings, media range requests, API |
| `server/encoder.mjs` | FFmpeg command, lifecycle, retry, end time, recovery |
| `server/store.mjs` | Persistent state and encrypted stream key |
| `compose.yaml`, `Dockerfile`, `Caddyfile` | VPS hosting, restart, HTTPS, optional browser password |

Copy `.env.example` to `.env` for overrides. `MAX_UPLOAD_GB=5` and `MAX_STORAGE_GB=20` are the default logical limits; the server also checks available disk space. Local runtime data lives in `data/` and is excluded from version control. Docker uses its named volume instead. The API deliberately accepts only a YouTube key, not arbitrary RTMP server URLs.

MP4/H.264 is best for browser previews. MOV/MKV/AVI and some WebM codecs may not preview in the browser but can still be encoded by the server. Invalid files are rejected and removed. Uploads are single-file and are not resumable; interrupted uploads must be repeated.

## Verification

```sh
npm test
npm run build
npm run test:browser
```

The tests cover real FFmpeg encoding and audio, video looping beyond source duration, upload validation and cleanup, media range requests, encrypted keys, settings validation, single-process control, stop, retry cancellation, stall detection, scheduled stop, and restart recovery. Browser tests cover the production UI and the local Vite proxy, including real drag-and-drop uploads of small and 32 MB disk-backed videos. They use installed Microsoft Edge on Windows (or Playwright Chromium on other systems). On systems without a browser, install one using `npx playwright install chromium` before running browser tests; on Windows the config expects Edge.

**A real YouTube broadcast has not been tested:** that needs your enabled channel and a fresh stream key. Docker/HTTPS deployment also needs a VPS; the local verification cannot prove a deployment that has not happened.
