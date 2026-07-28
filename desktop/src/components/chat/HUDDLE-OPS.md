# Huddle (LiveKit) — Operator Install Guide

The Aura desktop has an audio-only "huddle" surface (with optional
screenshare) built on top of a self-hosted **LiveKit SFU**. The Aura
codebase ships the client UI (`CallPanel.tsx`) and the token-mint
endpoint (`aura-cloud/src/calls.rs`) — but the SFU itself is an
operator install. This doc walks through that one-time setup.

Target host: the existing Aura VPS
(`ubuntu@<SERVER_IP>`, SSH key
`<SSH_KEY>`).

Total time: ~15 minutes.

---

## 1. Install the LiveKit server binary

SSH into the VPS:

```sh
ssh -i "<SSH_KEY>" ubuntu@<SERVER_IP>
```

Run the official installer (drops a static binary into
`/usr/local/bin/livekit-server`):

```sh
curl -sSL https://get.livekit.io | bash
```

Verify:

```sh
livekit-server --version
```

## 2. Generate API credentials

```sh
livekit-server generate-keys
```

Output looks like:

```
API Key:    APIxxxxxxxxxxxx
API Secret: secretxxxxxxxxxxxxxxxxxxxxxxxx
```

**Copy both values somewhere safe** — you'll paste them into
`livekit.yaml` (next step) and `/opt/aura-cloud/.env` (step 7).

## 3. Write the LiveKit config

Create `/etc/livekit/livekit.yaml`:

```sh
sudo mkdir -p /etc/livekit
sudo tee /etc/livekit/livekit.yaml >/dev/null <<'YAML'
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  APIxxxxxxxxxxxx: secretxxxxxxxxxxxxxxxxxxxxxxxx
YAML
```

Replace the placeholder key/secret on the last line with the ones from
step 2. `use_external_ip: true` lets LiveKit auto-discover the VPS's
public IP so WebRTC ICE candidates work for remote callers.

## 4. Create the systemd unit

```sh
sudo tee /etc/systemd/system/livekit.service >/dev/null <<'UNIT'
[Unit]
Description=LiveKit SFU
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=on-failure
RestartSec=5
User=ubuntu
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now livekit
sudo systemctl status livekit --no-pager
```

The status line should read `active (running)`.

## 5. Nginx reverse proxy + TLS

Create `/etc/nginx/sites-available/livekit.auravcs.com`:

```sh
sudo tee /etc/nginx/sites-available/livekit.auravcs.com >/dev/null <<'NGINX'
server {
    listen 80;
    server_name livekit.auravcs.com;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/livekit.auravcs.com \
            /etc/nginx/sites-enabled/livekit.auravcs.com
sudo nginx -t && sudo systemctl reload nginx
```

DNS: add an A record for `livekit.auravcs.com` pointing to
`<SERVER_IP>` (Route 53 / Cloudflare — whatever you use). Wait for
propagation (usually < 60s), then mint the cert:

```sh
sudo certbot --nginx -d livekit.auravcs.com --non-interactive --agree-tos -m ops@auravcs.com
```

Certbot will rewrite the nginx config in place and add the cert paths.

## 6. Firewall

WebRTC needs the UDP media range open in addition to the TLS WebSocket
port. UFW example:

```sh
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp                # TCP fallback for restricted networks
sudo ufw allow 50000:60000/udp         # RTP media range from livekit.yaml
sudo ufw reload
```

If you're on AWS/EC2, mirror these rules in the security group: TCP 443,
TCP 7881, UDP 50000–60000.

## 7. Wire the cloud token-mint to the new SFU

The `aura-cloud` service reads three env vars at request time, so no
rebuild is needed — just edit the env file and restart:

```sh
sudo tee -a /opt/aura-cloud/.env >/dev/null <<'ENV'
LIVEKIT_URL=wss://livekit.auravcs.com
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET=secretxxxxxxxxxxxxxxxxxxxxxxxx
ENV

sudo systemctl restart aura-cloud
```

Smoke test the mint endpoint:

```sh
curl -sX POST https://auravcs.com/api/v1/call/token \
  -H "content-type: application/json" \
  -d '{"room_id":"0123456789abcdef0123456789abcdef","channel":"general","identity":"smoketest","display_name":"Smoke Test"}' \
  | jq
```

Expected response shape:

```json
{
  "url": "wss://livekit.auravcs.com",
  "token": "eyJhbGciOi...",
  "room": "huddle:0123456789abcdef0123456789abcdef:general"
}
```

If you instead get `{"error":"livekit not configured"}` — the env vars
didn't reach the process. Confirm with `sudo systemctl show aura-cloud
-p Environment` and re-check the `.env` path matches your unit file's
`EnvironmentFile=` directive.

## 8. macOS Screen Recording permission (client-side)

Aura's existing **Permissions** onboarding panel covers this — but if
the user dismissed it earlier, screenshare from the huddle will produce
a black frame until they grant it manually:

> System Settings → Privacy & Security → Screen Recording → enable
> **Aura**.

After granting, Aura must be relaunched for the permission to take
effect (macOS behaviour, not ours).

The microphone permission is requested automatically on first mic
toggle.

---

## Troubleshooting

- **Browser shows "websocket failed" connecting to `wss://livekit.auravcs.com`** —
  TLS cert missing or nginx not reloaded. Re-run step 5.
- **Audio works but screenshare just spins** — UDP 50000–60000 blocked.
  Re-check step 6 firewall rules on both UFW and the cloud security
  group.
- **Token mints fine but client gets 401 on connect** — `LIVEKIT_API_KEY`
  in `/opt/aura-cloud/.env` doesn't match the key in
  `/etc/livekit/livekit.yaml`. They MUST be the same pair.
- **Calls drop after a few minutes** — `proxy_read_timeout` in the
  nginx config. Make sure it's set to `86400` (or higher) as in step 5.

## What's deliberately NOT here

- No authentication on `/api/v1/call/token` — same trust model as
  `/api/v1/room/<id>/messages`: anyone who already has the repo can
  derive the same `room_id` SHA, which IS the membership boundary.
- No recording / egress server. If you want recording later, install
  `livekit-egress` separately and point it at the SFU.
- No TURN server. LiveKit's built-in ICE works for ~95% of NAT setups;
  if your team includes someone behind a symmetric NAT, you'll need to
  add a TURN relay (coturn) and reference it from `livekit.yaml` →
  `turn:` section.
