# Deployment

This guide covers deploying Ontofelia in production environments.

## Quick Start (Development)

```bash
pnpm install && pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js gateway
```

## systemd Service

### Create the service file

```ini
# /etc/systemd/system/ontofelia.service
[Unit]
Description=Ontofelia Agent Gateway
After=network.target
Wants=network.target

[Service]
Type=simple
User=ontofelia
Group=ontofelia
WorkingDirectory=/opt/ontofelia
ExecStart=/usr/bin/node apps/cli/dist/index.js gateway
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=ONTOFELIA_HOME=/home/ontofelia/.ontofelia

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ontofelia/.ontofelia
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Install and start

```bash
# Create user
sudo useradd -r -m -s /bin/bash ontofelia

# Copy application
sudo cp -r . /opt/ontofelia
sudo chown -R ontofelia:ontofelia /opt/ontofelia

# Initialize
sudo -u ontofelia node /opt/ontofelia/apps/cli/dist/index.js init

# Enable and start
sudo systemctl enable ontofelia
sudo systemctl start ontofelia
sudo systemctl status ontofelia
```

### View logs

```bash
sudo journalctl -u ontofelia -f
```

## Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  ontofelia:
    build: .
    ports:
      - "18780:18780"
    volumes:
      - ontofelia-data:/home/node/.ontofelia
    environment:
      - NODE_ENV=production
      - ONTOFELIA_HOME=/home/node/.ontofelia
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18780/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  ontofelia-data:
```

### Dockerfile

```dockerfile
FROM node:22-slim

# curl is used by the healthcheck. The default Oxigraph backend is embedded
# (no Java needed). Add `openjdk-17-jre-headless` only if you switch the
# memory backend to the legacy Fuseki sidecar.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

# Install and build
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Initialize
RUN node apps/cli/dist/index.js init

EXPOSE 18780
CMD ["node", "apps/cli/dist/index.js", "gateway"]
```

## Reverse Proxy (nginx)

If you want to expose Ontofelia behind a reverse proxy:

```nginx
# /etc/nginx/sites-available/ontofelia
server {
    listen 443 ssl http2;
    server_name ontofelia.example.com;

    ssl_certificate /etc/letsencrypt/live/ontofelia.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ontofelia.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18780;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout
        proxy_read_timeout 86400;
    }
}
```

> **Important:** When exposing Ontofelia to the network, update `gateway.bind` to `"0.0.0.0"` in your config and ensure token authentication is enforced.

## SSH Tunnel (Simplest Remote Access)

For personal use, an SSH tunnel is the simplest and most secure option:

```bash
# On your local machine
ssh -L 18780:127.0.0.1:18780 your-server

# Now access Ontofelia at http://localhost:18780
```

## Tailscale / VPN

Ontofelia works perfectly over Tailscale or any VPN:

```json5
// Bind to all interfaces (safe because Tailscale handles auth)
gateway: {
  bind: "0.0.0.0",
  port: 18780
}
```

## Backup

### What to Back Up

| Path | Content | Priority |
|------|---------|----------|
| `~/.ontofelia/ontofelia.json5` | Configuration | Critical |
| `~/.ontofelia/auth.json` | OAuth tokens | Important |
| `~/.ontofelia/data/sessions.db` | Session index | Important |
| `~/.ontofelia/data/transcripts/` | Chat history | Important |
| `~/.ontofelia/oxigraph/` | Knowledge graph (default backend) | **Critical** |
| `~/.ontofelia/fuseki/data/` | Knowledge graph (only if Fuseki backend) | **Critical** |
| `~/.ontofelia/workspace/` | Agent workspace | Important |

### Backup Script

```bash
#!/bin/bash
BACKUP_DIR="/backups/ontofelia/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"

# Stop gateway for consistent backup
systemctl stop ontofelia

# Copy critical data
cp -r ~/.ontofelia/ontofelia.json5 "$BACKUP_DIR/"
cp -r ~/.ontofelia/data/ "$BACKUP_DIR/data/"
# Knowledge graph: default is Oxigraph (embedded). Use the path for whichever backend is active.
[ -d ~/.ontofelia/oxigraph ] && cp -r ~/.ontofelia/oxigraph/ "$BACKUP_DIR/oxigraph/"
[ -d ~/.ontofelia/fuseki/data ] && cp -r ~/.ontofelia/fuseki/data/ "$BACKUP_DIR/fuseki-data/"
cp -r ~/.ontofelia/workspace/ "$BACKUP_DIR/workspace/"

# Restart
systemctl start ontofelia

echo "Backup complete: $BACKUP_DIR"
```

## Monitoring

### Health Check

```bash
curl http://127.0.0.1:18780/api/health
```

### Prometheus Metrics (Planned)

A `/metrics` endpoint for Prometheus is on the roadmap.

## Resource Requirements

| Component | RAM | CPU | Disk |
|-----------|-----|-----|------|
| Gateway (Node.js, incl. embedded Oxigraph) | ~150-250 MB | 1 core | Depends on graph size |
| Fuseki (Java, only if `backend = "fuseki"`) | ~200-400 MB | 1 core | Depends on data |
| SQLite | Minimal | Minimal | ~1 MB per 10K messages |
| **Total (Oxigraph)** | **~150-250 MB** | **1-2 cores** | **~500 MB** |
| **Total (Fuseki)** | **~400-600 MB** | **2 cores** | **~1 GB** |

For small to medium workloads (< 100K triples, < 50K messages), a VPS with 512 MB RAM and 1 core is enough with the embedded Oxigraph backend; the Fuseki sidecar adds the Java footprint.

## Production Checklist

Before running Ontofelia in a production environment or exposing it to the internet, ensure you have completed the following checklist:

- [ ] **Docker Sandboxing:** Ensure `sandbox.scope` is set to `"session"` or `"agent"` in `ontofelia.json5`. Avoid `scope: "off"` (NoopSandbox) in production.
- [ ] **Tool Allowlist:** Only enable the exact host-tools required. Explicitly set `tools.deny` for highly sensitive tools like `exec` if they are not needed.
- [ ] **Reverse Proxy & SSL:** Place Ontofelia behind a reverse proxy (e.g., Nginx or Caddy) with an SSL/TLS certificate (HTTPS/WSS).
- [ ] **Network Binding:** Keep `gateway.bind` at `"127.0.0.1"` if using a reverse proxy on the same host, or use a secure VPN like Tailscale if binding to `"0.0.0.0"`.
- [ ] **Token Authentication:** Do not share the `ontofelia.json5` gateway token. Verify that Web UI and CLI use this token securely.
- [ ] **Plugin Security:** Keep `plugins.allowUntrusted` as `false` (default) and explicitly verify any plugins added to `plugins.trusted`.
- [ ] **Service User:** Run Ontofelia as a dedicated, unprivileged system user (e.g., `ontofelia`), never as `root`.
- [ ] **Backup Strategy:** Implement automated backups for the knowledge graph (`~/.ontofelia/oxigraph/` with the default backend, or `~/.ontofelia/fuseki/data/` if the legacy Fuseki backend is active) and the `ontofelia.json5` configuration.
