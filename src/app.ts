import { Elysia, t } from "elysia";
import type { SQL, Server } from "bun";

export interface Config {
  allowRegistration: boolean;
  trustProxy: boolean;
  maxRecordsPerUser: number;
}

export const SESSION_IDLE = 180 * 86400;
const PUSH_LIMIT = 500;
const PULL_LIMIT = 1000;
const MAX_DATA_BYTES = 16 * 1024;
const PARTY_MEMBERS = 16;
const PARTIES_PER_USER = 3;
const PARTIES = 1000;
const PARTY_EMPTY_TTL = 600;
const PARTY_MAX_AGE = 12 * 3600;
// Bun drops connections idle for longer than serve.idleTimeout.
const HEARTBEAT_MS = 15_000;

export const now = () => Math.floor(Date.now() / 1000);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

function limiter(max: number, windowSeconds: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  const live = (key: string) => {
    const h = hits.get(key);
    return h && h.reset > now() ? h : undefined;
  };
  return {
    count(key: string): boolean {
      if (hits.size > 10_000) for (const [k, h] of hits) if (h.reset <= now()) hits.delete(k);
      const h = live(key) ?? { n: 0, reset: now() + windowSeconds };
      h.n++;
      hits.set(key, h);
      return h.n > max;
    },
    reserve(key: string): (() => void) | undefined {
      if ((live(key)?.n ?? 0) >= max) return;
      if (hits.size > 10_000) for (const [k, h] of hits) if (h.reset <= now()) hits.delete(k);
      const h = live(key) ?? { n: 0, reset: now() + windowSeconds };
      h.n++;
      hits.set(key, h);
      return () => { if (hits.get(key) === h && --h.n === 0) hits.delete(key); };
    },
  };
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const randomToken = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

function checkUsername(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name))
    fail(422, "Username must be 3–32 letters, numbers, dots, dashes or underscores.");
  return name;
}

function checkPassword(password: string) {
  if (password.length < 8) fail(422, "Password must be at least 8 characters.");
}

const credentials = t.Object({
  username: t.String({ maxLength: 64 }),
  password: t.String({ minLength: 1, maxLength: 128 }),
  device: t.Optional(t.String({ maxLength: 64 })),
});

const change = t.Object({
  kind: t.String({ pattern: "^[a-z][a-zA-Z]{0,31}$" }),
  key: t.String({ minLength: 1, maxLength: 512 }),
  updatedAt: t.Integer({ minimum: 0 }),
  deleted: t.Optional(t.Boolean()),
  data: t.Optional(t.Unknown()),
});

const anime = t.Object({
  name: t.String({ maxLength: 300 }),
  url: t.String({ minLength: 1, maxLength: 2048 }),
  image: t.String({ maxLength: 2048 }),
  source: t.String({ minLength: 1, maxLength: 64 }),
  anilistId: t.Integer({ minimum: 0 }),
});
const playback = {
  episode: t.Number({ minimum: 0, maximum: 100_000 }),
  position: t.Number({ minimum: 0, maximum: 1_000_000 }),
  paused: t.Boolean(),
  speed: t.Number({ minimum: 0.25, maximum: 4 }),
};
const partyId = t.Object({ id: t.String({ pattern: "^[A-Za-z0-9_-]{22}$" }) });

type Anime = typeof anime.static;
type Shared = { anime: Anime; episode: number; position: number; paused: boolean; speed: number; at: number; by: string; rev: number };
type Listener = { username: string; device: string; send: (event: string, data: unknown) => void };
// Watch together. Parties live in memory: they last hours at most, so one server instance holds them all.
type Party = { host: string; created: number; emptySince: number; users: Set<string>; listeners: Set<Listener>; state: Shared };

// Opens the app; built from the page's own address, which the server may not know behind a proxy.
const PARTY_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch together · Aikatsu</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center;
         font: 16px system-ui, sans-serif; background: #191113; color: #efdfe1; }
  .open { display: inline-block; padding: 14px 28px; border-radius: 999px; background: #ffb1c6; color: #5e1131;
          font-weight: 600; text-decoration: none; }
  p { color: #d5c2c6; }
  p a { color: inherit; }
</style>
<main>
  <h1>Watch together</h1>
  <p><a class="open" id="open" href="#">Open in Aikatsu</a></p>
  <p>Sign in to this server in Aikatsu first.</p>
  <p><a href="https://github.com/KidiXDev/aikatsu/releases/latest">Get Aikatsu</a></p>
</main>
<script>
  const m = location.pathname.match(/^(.*)\/party\/([A-Za-z0-9_-]+)\/?$/);
  if (m) document.getElementById("open").href =
    "aikatsu://party?server=" + encodeURIComponent(location.origin + m[1]) + "&id=" + m[2];
</script>
</html>
`;

type Row = { kind: string; key: string; data: string; updated_at: number | string; deleted: number; seq: number | string };

// Postgres returns BIGINT as strings, SQLite as numbers.
const toChange = (r: Row) => ({
  kind: r.kind,
  key: r.key,
  updatedAt: Number(r.updated_at),
  deleted: Number(r.deleted) === 1,
  data: JSON.parse(r.data),
});

export function createApp(sql: SQL, config: Config) {
  // Unknown usernames still pay for a verify, so timing doesn't reveal which names exist.
  const dummyHash = Bun.password.hash(randomToken(16));
  const newAccounts = limiter(5, 3600);
  const nameFailures = limiter(10, 900);
  const ipFailures = limiter(50, 900);
  const requests = limiter(120, 60);
  let passwordJobs = 0;
  async function passwordWork<T>(work: () => Promise<T>): Promise<T> {
    if (passwordJobs >= 4) fail(429, "Too many sign-in requests. Try again shortly.");
    passwordJobs++;
    try { return await work(); }
    finally { passwordJobs--; }
  }

  function passwordAttempt(username: string, ip: string) {
    const releaseName = nameFailures.reserve(username);
    if (!releaseName) return fail(429, "Too many wrong passwords. Try again in 15 minutes.");
    const releaseIp = ipFailures.reserve(ip);
    if (!releaseIp) {
      releaseName();
      return fail(429, "Too many wrong passwords. Try again in 15 minutes.");
    }
    return () => { releaseName(); releaseIp(); };
  }

  const ipOf = (request: Request, server: Server<unknown> | null) => {
    const forwarded = config.trustProxy && request.headers.get("x-forwarded-for");
    return forwarded ? forwarded.split(",").at(-1)!.trim() : (server?.requestIP(request)?.address ?? "unknown");
  };

  async function createSession(userId: string, passwordHash: string, device = "") {
    const token = randomToken(32);
    await sql.begin(async (tx) => {
      // Serialize with password resets and account deletion before issuing a session.
      const locked = await tx`UPDATE users SET seq = seq WHERE id = ${userId} AND password_hash = ${passwordHash} RETURNING id`;
      if (!locked.length) fail(401, "Sign-in changed. Try again.");
      await tx`INSERT INTO sessions (token_hash, user_id, device, created_at, last_used_at)
                VALUES (${sha256(token)}, ${userId}, ${device}, ${now()}, ${now()})`;
    });
    return token;
  }

  async function authenticate(header: string | undefined) {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const tokenHash = sha256(token);
    const [s] = token
      ? await sql`SELECT s.user_id, s.last_used_at, u.username, u.password_hash
                  FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${tokenHash}`
      : [];
    if (!s || Number(s.last_used_at) < now() - SESSION_IDLE) fail(401, "Session expired.");
    if (Number(s.last_used_at) < now() - 3600) await sql`UPDATE sessions SET last_used_at = ${now()} WHERE token_hash = ${tokenHash}`;
    if (requests.count(s.user_id)) fail(429, "Too many requests. Try again in a minute.");
    return { id: s.user_id as string, username: s.username as string, passwordHash: s.password_hash as string, tokenHash };
  }

  async function verify(user: { username: string; passwordHash: string }, password: string, ip: string) {
    const release = passwordAttempt(user.username, ip);
    let ok: boolean;
    try { ok = await passwordWork(() => Bun.password.verify(password, user.passwordHash)); }
    catch (e) { release(); throw e; }
    if (ok) { release(); return; }
    fail(403, "Wrong password.");
  }

  const parties = new Map<string, Party>();

  function sweepParties() {
    for (const [id, p] of parties)
      if ((p.emptySince && p.emptySince < now() - PARTY_EMPTY_TTL) || p.created < now() - PARTY_MAX_AGE) parties.delete(id);
  }

  const party = (id: string) => parties.get(id) ?? fail(404, "This party has ended.");

  function broadcast(p: Party, event: string, data: unknown) {
    for (const l of p.listeners) l.send(event, data);
  }

  const members = (p: Party) => [...p.listeners].map(({ username, device }) => ({ username, device }));
  const shared = (p: Party) => ({ ...p.state, now: Date.now() });

  function listen(p: Party, user: { id: string; username: string }, device: string, signal: AbortSignal) {
    if (p.listeners.size >= PARTY_MEMBERS) fail(429, "This party is full.");
    const encoder = new TextEncoder();
    let listener: Listener | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const leave = () => {
      clearInterval(heartbeat);
      if (!listener || !p.listeners.delete(listener)) return;
      if (!p.listeners.size) p.emptySince = now();
      broadcast(p, "members", members(p));
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          try { controller.enqueue(encoder.encode(chunk)); }
          catch { leave(); }
        };
        listener = { username: user.username, device, send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) };
        p.users.add(user.id);
        p.listeners.add(listener);
        p.emptySince = 0;
        listener.send("state", shared(p));
        broadcast(p, "members", members(p));
        heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
        signal.addEventListener("abort", leave);
      },
      cancel: leave,
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  return new Elysia({ serve: { maxRequestBodySize: 2 * 1024 * 1024, idleTimeout: 2 * HEARTBEAT_MS / 1000 } })
    .onError(({ code, error, set }) => {
      if (error instanceof HttpError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (code === "VALIDATION" || code === "PARSE") {
        set.status = 422;
        return { error: "Invalid request." };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "Not found." };
      }
      console.error(error);
      set.status = 500;
      return { error: "Server error." };
    })
    .get("/health", async () => {
      await sql`SELECT 1`;
      return { ok: true };
    })
    .get(
      "/party/:id",
      () =>
        new Response(PARTY_PAGE, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
          },
        }),
      { params: partyId },
    )
    .post(
      "/auth/register",
      async ({ body, request, server, set }) => {
        if (!config.allowRegistration) fail(403, "Sign-ups are closed.");
        const ip = ipOf(request, server);
        if (newAccounts.count(ip)) fail(429, "Too many sign-ups. Try again later.");
        const username = checkUsername(body.username);
        checkPassword(body.password);
        // Checked before hashing so taken names cost nothing.
        const [taken] = await sql`SELECT 1 FROM users WHERE username = ${username}`;
        if (taken) fail(409, "Username is taken.");
        const id = Bun.randomUUIDv7();
        const passwordHash = await passwordWork(() => Bun.password.hash(body.password));
        const created = await sql`INSERT INTO users (id, username, password_hash, created_at)
                                  VALUES (${id}, ${username}, ${passwordHash}, ${now()})
                                  ON CONFLICT (username) DO NOTHING RETURNING id`;
        if (!created.length) fail(409, "Username is taken.");
        set.status = 201;
        return { token: await createSession(id, passwordHash, body.device), username };
      },
      { body: credentials },
    )
    .post(
      "/auth/login",
      async ({ body, request, server }) => {
        const username = body.username.trim().toLowerCase();
        const ip = ipOf(request, server);
        const release = passwordAttempt(username, ip);
        let user: { id: string; password_hash: string } | undefined;
        let ok: boolean;
        try {
          [user] = await sql`SELECT id, password_hash FROM users WHERE username = ${username}`;
          const hash = user?.password_hash ?? (await dummyHash);
          ok = await passwordWork(() => Bun.password.verify(body.password, hash));
        } catch (e) { release(); throw e; }
        if (!user || !ok) {
          return fail(401, "Wrong username or password.");
        }
        release();
        return { token: await createSession(user.id, user.password_hash, body.device), username };
      },
      { body: credentials },
    )
    .guard({}, (app) =>
      app
        .resolve(async ({ headers }) => ({ user: await authenticate(headers.authorization) }))
        .post("/auth/logout", async ({ user }) => {
          await sql`DELETE FROM sessions WHERE token_hash = ${user.tokenHash}`;
          return new Response(null, { status: 204 });
        })
        .post(
          "/account/password",
          async ({ user, body, request, server }) => {
            await verify(user, body.current, ipOf(request, server));
            checkPassword(body.password);
            const passwordHash = await passwordWork(() => Bun.password.hash(body.password));
            await sql.begin(async (tx) => {
              const changed = await tx`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${user.id} AND password_hash = ${user.passwordHash} RETURNING id`;
              if (!changed.length) fail(401, "Account changed. Sign in again.");
              await tx`DELETE FROM sessions WHERE user_id = ${user.id} AND token_hash <> ${user.tokenHash}`;
            });
            return new Response(null, { status: 204 });
          },
          { body: t.Object({ current: t.String({ minLength: 1, maxLength: 128 }), password: t.String({ maxLength: 128 }) }) },
        )
        .post(
          "/account/delete",
          async ({ user, body, request, server }) => {
            await verify(user, body.password, ipOf(request, server));
            await sql.begin(async (tx) => {
              const locked = await tx`UPDATE users SET seq = seq WHERE id = ${user.id} AND password_hash = ${user.passwordHash} RETURNING id`;
              if (!locked.length) fail(401, "Account changed. Sign in again.");
              await tx`DELETE FROM records WHERE user_id = ${user.id}`;
              await tx`DELETE FROM sessions WHERE user_id = ${user.id}`;
              await tx`DELETE FROM users WHERE id = ${user.id}`;
            });
            return new Response(null, { status: 204 });
          },
          { body: t.Object({ password: t.String({ minLength: 1, maxLength: 128 }) }) },
        )
        .post(
          "/sync",
          async ({ user, body }) => {
            // Newest change per record: Postgres refuses to upsert one row twice in a statement.
            const id = (c: { kind: string; key: string }) => `${c.kind}\n${c.key}`;
            const latest = new Map<string, (typeof body.changes)[number]>();
            for (const c of body.changes) if ((latest.get(id(c))?.updatedAt ?? -1) <= c.updatedAt) latest.set(id(c), c);
            const changes = [...latest.values()];
            const rejected: Row[] = [];
            if (changes.length) {
              const rows = changes.map((c) => {
                const data = JSON.stringify(c.deleted ? null : (c.data ?? null));
                if (Buffer.byteLength(data) > MAX_DATA_BYTES) fail(413, "A record is too large.");
                return { user_id: user.id, kind: c.kind, key: c.key, data, updated_at: Math.min(c.updatedAt, now() + 60), deleted: c.deleted ? 1 : 0, seq: 0 };
              });
              await sql.begin(async (tx) => {
                // Locks the user row until commit, so a pull never skips a seq.
                const [locked] = await tx`UPDATE users SET seq = seq + ${rows.length} WHERE id = ${user.id} RETURNING seq`;
                if (!locked) fail(401, "Session expired.");
                const { seq } = locked;
                const [{ n }] = await tx`SELECT COUNT(*) AS n FROM records WHERE user_id = ${user.id}`;
                const keys = [...new Set(rows.map((r) => r.key))];
                const existing = new Set((await tx`SELECT kind, key FROM records WHERE user_id = ${user.id} AND key IN ${sql(keys)}`).map(id));
                const added = rows.filter((r) => !existing.has(id(r))).length;
                if (Number(n) + added > config.maxRecordsPerUser) fail(413, "Storage limit reached.");
                rows.forEach((r, i) => (r.seq = Number(seq) - rows.length + i + 1));
                const accepted = new Set(
                  (await tx`INSERT INTO records ${sql(rows)}
                            ON CONFLICT (user_id, kind, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
                              deleted = excluded.deleted, seq = excluded.seq
                            WHERE excluded.updated_at > records.updated_at
                            RETURNING kind, key`).map(id),
                );
                // Send back what beat these, even if the client's cursor is already past it.
                const lost = changes.filter((c) => !accepted.has(id(c)));
                if (lost.length) {
                  const keys = [...new Set(lost.map((c) => c.key))];
                  const lostIds = new Set(lost.map(id));
                  for (const r of await tx`SELECT kind, key, data, updated_at, deleted, seq FROM records
                                           WHERE user_id = ${user.id} AND key IN ${sql(keys)}`)
                    if (lostIds.has(id(r))) rejected.push(r);
                }
              });
            }
            const rows: Row[] = await sql`SELECT kind, key, data, updated_at, deleted, seq FROM records
                                          WHERE user_id = ${user.id} AND seq > ${body.cursor} ORDER BY seq LIMIT ${PULL_LIMIT}`;
            const pulled = new Set(rows.map(id));
            return {
              cursor: rows.length ? Number(rows.at(-1)!.seq) : body.cursor,
              more: rows.length === PULL_LIMIT,
              changes: [...rows, ...rejected.filter((r) => !pulled.has(id(r)))].map(toChange),
            };
          },
          { body: t.Object({ cursor: t.Integer({ minimum: 0 }), changes: t.Array(change, { maxItems: PUSH_LIMIT }) }) },
        )
        .post(
          "/party",
          ({ user, body, set }) => {
            sweepParties();
            // Ones the host has left would only block new ones until they expire.
            for (const [id, p] of parties) if (p.host === user.id && !p.listeners.size) parties.delete(id);
            if ([...parties.values()].filter((p) => p.host === user.id).length >= PARTIES_PER_USER) fail(429, "Too many parties.");
            if (parties.size >= PARTIES) fail(503, "The server is busy. Try again later.");
            const id = randomToken(16);
            parties.set(id, {
              host: user.id,
              created: now(),
              emptySince: now(),
              users: new Set([user.id]),
              listeners: new Set(),
              state: { ...body, at: Date.now(), by: user.username, rev: 1 },
            });
            set.status = 201;
            return { id };
          },
          { body: t.Object({ anime, ...playback }) },
        )
        .get(
          "/party/:id/events",
          ({ user, params, query, request }) => {
            sweepParties();
            return listen(party(params.id), user, query.device ?? "", request.signal);
          },
          { params: partyId, query: t.Object({ device: t.Optional(t.String({ maxLength: 64 })) }) },
        )
        .post(
          "/party/:id/state",
          ({ user, params, body }) => {
            const p = party(params.id);
            if (!p.users.has(user.id)) fail(403, "Join the party first.");
            p.state = { ...p.state, ...body, at: Date.now(), by: user.username, rev: p.state.rev + 1 };
            broadcast(p, "state", shared(p));
            return { rev: p.state.rev };
          },
          { params: partyId, body: t.Object({ anime: t.Optional(anime), ...playback }) },
        ),
    );
}
