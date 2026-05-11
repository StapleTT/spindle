# Production Deployment

PM2 is the recommended process manager for running Spindle in production. It handles auto-start at boot, crash recovery, hang detection, and log management.

---

## Install PM2

```bash
npm install -g pm2
```

---

## Start Spindle with PM2

```bash
cd /path/to/spindle
pm2 start server.js --name spindle --listen-timeout 10000
```

`--listen-timeout 10000` tells PM2 to consider the app hung if it does not send a ready signal within 10 seconds of starting. Spindle sends this signal via `process.send('ready')` inside the `app.listen` callback.

---

## Auto-start at boot

Generate and install the startup script for your init system:

```bash
pm2 startup
```

PM2 will print a command to run as root -- copy and run it. Then save the current process list so it is restored on reboot:

```bash
pm2 save
```

### Alpine Linux (OpenRC)

On Alpine, specify the init system explicitly:

```bash
pm2 startup openrc
# Run the printed command as root
pm2 save
```

---

## Log management

Install the PM2 log rotation module to prevent logs from growing unbounded:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

This rotates logs when they exceed 20 MB and keeps 14 rotated files (roughly two weeks at normal load).

---

## Common PM2 commands

| Command | Description |
|---|---|
| `pm2 status` | Show running processes and their status |
| `pm2 logs spindle` | Stream live logs |
| `pm2 logs spindle --lines 100` | Show last 100 log lines |
| `pm2 restart spindle` | Restart the process |
| `pm2 reload spindle` | Zero-downtime reload |
| `pm2 stop spindle` | Stop the process |
| `pm2 delete spindle` | Remove from PM2 |

---

## Deploying updates

```bash
git pull
npm install          # only needed if dependencies changed
pm2 reload spindle   # zero-downtime reload
```
