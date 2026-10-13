# Dhruv-Setu CRM

A portable tourism CRM with role-based dashboards, dynamic docket fields, report exports and mail configuration. The same source runs on Windows, Ubuntu/Linux and Docker.

## Requirements

- Direct hosting: Node.js 20 or newer
- Container hosting: Docker Engine with Docker Compose

No npm package installation is required for the current build.

## Windows

Run from PowerShell:

```powershell
.\scripts\start-windows.ps1
```

If PowerShell script execution is restricted, use:

```powershell
node server.mjs
```

## Ubuntu / Linux

```bash
chmod +x scripts/start-linux.sh
./scripts/start-linux.sh
```

## Docker Compose

```bash
docker compose up -d --build
```

Open `http://localhost:8080`. To use a different host port, copy `.env.example` to `.env` and change `APP_PORT`.

## Docker without Compose

```bash
docker build -t dhruv-setu-crm .
docker run -d --name dhruv-setu-crm --restart unless-stopped -p 8080:8080 dhruv-setu-crm
```

## Operations

- Application: `http://localhost:8080`
- Health check: `http://localhost:8080/health`
- Custom direct-hosting port: set the `PORT` environment variable

## Demo accounts

- User: `user` / `user123`
- Support: `support` / `support123`
- Admin: `admin` / `admin123`

Data currently persists in browser `localStorage`. Production authentication, shared database storage, SMTP delivery and dialer integration will be connected through a secure backend API in the next server-side phase.
# Enterprise database mode

Dhruv-Setu now uses PostgreSQL for server-side users, sessions and shared dockets. Browser passwords are no longer trusted or stored in the frontend.

For a new Docker deployment, copy `.env.example` to `.env`, replace every sample password, and run:

```bash
docker compose up --build -d
```

For direct Windows or Linux hosting, install PostgreSQL, create a database, set `DATABASE_URL`, then run `npm start`. The schema and initial role accounts are created automatically. Set `COOKIE_SECURE=true` only when the CRM is served through HTTPS.
