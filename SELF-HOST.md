# Self-hosting this Label Studio fork

This fork adds a high-throughput verification UX on top of upstream Label Studio (grid reject
toggle, folder strips, brush hotkeys, claim/release, audit log — see
[HAPPYIN-FORK.md](HAPPYIN-FORK.md) for the full feature list). You can run it on your own data.

It does **not** require any of our infrastructure. The only things you provide are a Postgres
password and your public hostname — via a local `.env` that is never committed.

---

## 1. Prerequisites

- Docker + Docker Compose
- A domain you control (optional, only if exposing publicly)
- ~4 GB RAM for a small instance

## 2. Get the code

```bash
git clone -b cars-mods https://github.com/AnastasiyaW/happyin-labelstudio.git
cd happyin-labelstudio
```

`cars-mods` is the default branch and holds all the modifications. (Plain `main` tracks upstream
Label Studio without the mods.)

## 3. Configure secrets (local only — never committed)

```bash
cp cars/deployment/.env.example cars/deployment/.env
# edit cars/deployment/.env — set POSTGRES_PASSWORD and LABEL_STUDIO_HOST at minimum
```

`cars/deployment/.env`, any `.env`, and `*.dump` database backups are gitignored. The
`gitleaks` pre-commit hook (below) is your safety net if you ever try to commit one by accident.

## 4. Build & run

```bash
# Build the thin image (frontend overlay on the official Label Studio image):
docker build -f Dockerfile.thin -t happyin-labelstudio:latest .

# Bring up the stack (postgres + ls-backend + nginx + optional cloudflared):
docker compose -f cars/deployment/docker-compose.yml --env-file cars/deployment/.env up -d
```

The `label-studio` nginx service binds `127.0.0.1:8080` — put your own TLS / reverse proxy in
front of it, or keep the bundled `cloudflared` service and set `CF_TUNNEL_TOKEN` in `.env`.
If you do **not** use Cloudflare Tunnel, delete the `cloudflared` service from the compose file.

## 5. Pull updates later

```bash
git pull --ff-only origin cars-mods
# rebuild the frontend + recreate the container (see HAPPYIN-FORK.md → "Deploy pipeline")
```

---

## Secret safety — required setup for contributors

**Goal: no credential ever lands in git.** This repo ships a secret scanner; turn it on once:

```bash
pip install pre-commit
pre-commit install            # installs the git hook
# optional one-off full scan of your working tree:
pre-commit run gitleaks --all-files
```

After this, every `git commit` is scanned by [gitleaks](https://github.com/gitleaks/gitleaks)
(rules in [`.gitleaks.toml`](.gitleaks.toml)). A commit containing an API key, token, password,
or private key is **blocked** before it is created.

Rules of thumb:

- Put all secrets in `cars/deployment/.env` (gitignored). Commit only `.env.example` with
  placeholders.
- Never hardcode tokens/passwords in scripts, compose files, or docs — reference an env var.
- Database dumps (`*.dump`) and the served `files/` directory are gitignored; keep it that way.
- If gitleaks blocks you and it is a false positive, add a narrow allowlist entry to
  `.gitleaks.toml` (with a comment) rather than disabling the hook.

If a secret is ever pushed by mistake: **rotate it immediately** (the value is now compromised),
then scrub history with `git filter-repo` and force-push.
