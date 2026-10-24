# aikatsu-sync

The sync server for [Aikatsu](https://github.com/KidiXDev/aikatsu). It keeps watch history and settings the same on your phone and computer. The app uses the public instance by default. Run your own if you'd rather keep your history on your own machine.

It's a small [Bun](https://bun.sh) + [Elysia](https://elysiajs.com) service that stores data in SQLite (the default) or Postgres. The full self-hosting guide is on the [docs site](https://kidixdev.github.io/aikatsu/guide/self-hosting).

## Run it

**SQLite.** Everything is kept in a Docker volume:

```sh
curl -O https://raw.githubusercontent.com/KidiXDev/aikatsu-sync/main/compose.yaml
docker compose up -d
```

**Postgres:**

```sh
curl -O https://raw.githubusercontent.com/KidiXDev/aikatsu-sync/main/compose.postgres.yaml
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
docker compose -f compose.postgres.yaml up -d
```

Then, in Aikatsu, go to **Settings → Sync**, choose **Change** next to **Server**, enter `http://<your machine>:3000`, and create your account. The server can only be changed while signed out.

Use a reverse proxy with HTTPS, including on a shared home network: sync carries passwords, session tokens, and folder-sharing credentials. Plain HTTP is only suitable for a trusted development setup. With [Caddy](https://caddyserver.com), the whole config is:

```
sync.example.com {
    reverse_proxy localhost:3000
}
```

Then set `TRUST_PROXY: "true"`, so rate limits apply per visitor instead of to the proxy.

Watch-together parties are held in memory, so run one server process, and a restart ends them. Their live updates are server-sent events: Caddy passes them through as is; with nginx, turn off `proxy_buffering` for `/party/`.

## Configuration

| Variable               | Default                                    | What it does                                                                        |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `DATABASE_URL`         | `sqlite:///data/aikatsu-sync.db` in Docker | `sqlite://<path>` or `postgres://user:pass@host:5432/db`                            |
| `ALLOW_REGISTRATION`   | `true`                                     | Set `false` after creating your account, so no one else can sign up                 |
| `TRUST_PROXY`          | `false`                                    | Behind a reverse proxy: read the visitor's IP from the last `X-Forwarded-For` entry |
| `MAX_RECORDS_PER_USER` | `100000`                                   | Caps each account; a watched episode or a setting is one record                     |
| `PORT`                 | `3000`                                     | Port to listen on                                                                   |

## Admin tasks

There's no email, so a forgotten password is reset by whoever runs the server:

```sh
docker compose exec sync bun src/cli.ts reset-password <username>
```

This prints a new password and signs the account out everywhere.

**Back up SQLite:** run `docker compose stop`, copy the `data` volume, then run `docker compose start`. For Postgres, use `pg_dump`.

**Update:** run `docker compose pull && docker compose up -d`. The schema is created on startup.

## API

Every body is JSON. Every error is `{ "error": "<a sentence for the user>" }`.

Routes marked **auth** need `Authorization: Bearer <token>`. They return `401` once the session has ended (signed out, password changed, or unused for 180 days).

| Route                           | Body                              | Returns                                                                                            |
| ------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /health`                   |                                   | `{ ok: true }`                                                                                     |
| `POST /auth/register`           | `{ username, password, device? }` | `201 { token, username }`; `403` sign-ups closed, `409` name taken, `422` invalid name or password |
| `POST /auth/login`              | `{ username, password, device? }` | `{ token, username }`; `401` wrong username or password                                            |
| `POST /auth/logout` (auth)      |                                   | `204`                                                                                              |
| `POST /account/password` (auth) | `{ current, password }`           | `204`, other devices are signed out; `403` wrong current password                                  |
| `POST /account/delete` (auth)   | `{ password }`                    | `204`, the account and all its records are gone                                                    |
| `POST /sync` (auth)             | `{ cursor, changes: [Change] }`   | `{ cursor, more, changes: [Change] }`                                                              |
| `POST /party` (auth)            | `Playback`                        | `201 { id }`; `429` the account already has three parties going                                    |
| `GET /party/:id/events` (auth)  |                                   | Server-sent events, see [Watch together](#watch-together); `404` ended, `429` full                 |
| `POST /party/:id/state` (auth)  | `Playback`                        | `{ rev }`; `403` never joined, `404` ended                                                         |
| `GET /party/:id`                |                                   | A page showing what's playing and how many are in, with a button that opens the app; `404` ended |

- **Usernames** are 3–32 lowercase letters, digits, `.`, `_` or `-`. Logins ignore case.
- **Passwords** are 8–128 characters.

### Sync

A `Change` is `{ kind, key, updatedAt, deleted?, data? }`:

- **`kind`** is a short name such as `progress` or `setting`.
- **`key`** identifies the record within its kind.
- **`updatedAt`** is the device's Unix time in seconds when it changed.
- **`data`** is any JSON up to 16 KiB. The server stores it without reading it.

Each call pushes up to 500 local changes, then pulls whatever changed since `cursor`:

- **Newest wins.** A change is kept only if its `updatedAt` is newer than the stored one. Times more than a minute in the future are clamped to the server's clock.
- **Losing changes come back.** The response includes the stored record that beat them, even when the cursor has already passed it.
- **Deletions** are changes with `deleted: true`. They're kept, so other devices hear about them.
- **Paging:** keep the returned `cursor` for the next call, and call again while `more` is true. Start from `cursor: 0` to get everything.

### Watch together

`Playback` is `{ anime: { name, url, image, source, anilistId }, episode, position, paused, speed }`. `anime` is optional when updating.

Anyone signed in to this server can join a party by its id. Opening `/party/:id/events` joins it and streams:

- **`state`**: the party's `Playback` plus `at` (server time in ms when it was set), `now` (server time in ms when sent), `by` (the username that set it) and `rev`, which goes up with every change. While playing, the position now is `position + (now - at) / 1000 * speed`.
- **`members`**: `[{ username, device }]`, whenever someone joins or leaves.
- A `: ping` comment every 15 seconds.

The first two events are the current `state` and `members`. Any member can set the state, and the latest change wins. A party ends 10 minutes after its last member leaves, and after 12 hours at most. It holds up to 16 members.

### Limits

| What               | Limit                                     |
| ------------------ | ----------------------------------------- |
| Sign-up attempts   | 5 per hour per IP                         |
| Wrong passwords    | 10 per 15 minutes per username, 50 per IP |
| Signed-in requests | 120 per minute per account                |
| Request body       | 2 MiB                                     |

Password hashing and verification are limited to four concurrent operations per server process. Excess requests return `429`; retry shortly. Pending password attempts also count toward the failure limits until they succeed, so concurrent requests cannot bypass them. Storage limits count new records; updates and deletions of existing records still work at the limit.

## Develop

```sh
bun install
bun dev              # http://localhost:3000, SQLite in ./data
bun test             # SQLite in memory
bun run typecheck
TEST_DATABASE_URL=postgres://postgres:x@localhost:5432/postgres bun test   # the same tests on Postgres
docker build -t ghcr.io/kidixdev/aikatsu-sync .
```

Pushing a `v*` tag publishes the image to GHCR for amd64 and arm64.

## License

GPL-3.0
