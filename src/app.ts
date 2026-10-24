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
type Party = { host: string; hostName: string; created: number; emptySince: number; users: Set<string>; listeners: Set<Listener>; state: Shared };

const RELEASES = "https://github.com/KidiXDev/aikatsu/releases/latest";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function clock(seconds: number) {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const [h, m] = [Math.floor(s / 3600), Math.floor(s / 60) % 60];
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_PEOPLE = icon(`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`);
const ICON_TV = icon(`<rect x="2" y="7" width="20" height="15" rx="3"/><path d="m17 2-5 5-5-5"/>`);
const ICON_MOON = icon(`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`);

const PARTY_STYLE = `
  :root { color-scheme: dark; --bg: #130d0e; --card: #211719; --high: #2f2226; --text: #f6e0e4; --muted: #baa6aa; --line: #534448;
          --primary: #ff89b0; --on-primary: #610030; --wash: #7d2160; --on-wash: #ffbde0; --error: #ff6e84; --shadow: rgb(0 0 0 / .6); }
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; --bg: #fff8f8; --card: #fff0f2; --high: #f7e3e7; --text: #3c2f32; --muted: #6b5b5f; --line: #c1adb1;
            --primary: #ad1c5e; --on-primary: #ffeff1; --wash: #ffbfe1; --on-wash: #7d2160; --error: #b41340; --shadow: rgb(60 20 30 / .18); }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; text-align: center;
         font: 16px/1.5 "Google Sans Flex", "Google Sans", system-ui, sans-serif; color: var(--text);
         background: radial-gradient(110% 55% at 50% 0%, color-mix(in srgb, var(--primary) 14%, transparent), transparent 70%) var(--bg); }
  main { width: 100%; max-width: 400px; padding: 28px 24px 20px; border-radius: 28px; background: var(--card);
         box-shadow: 0 24px 64px -24px var(--shadow); animation: rise .35s cubic-bezier(.33, 1, .68, 1); }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } }
  p { margin: 0; }
  svg { width: 20px; height: 20px; flex: none; }
  .eyebrow { margin-bottom: 20px; font-size: 13px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .poster { position: relative; display: grid; place-items: center; width: 148px; aspect-ratio: 2 / 3; margin: 0 auto 20px;
            border-radius: 18px; overflow: hidden; background: var(--high); color: var(--muted); box-shadow: 0 16px 36px -14px var(--shadow); }
  .poster svg { width: 40px; height: 40px; }
  .poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .status { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 10px; padding: 3px 10px; border-radius: 999px;
            font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; background: var(--high); color: var(--muted); }
  .status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .status.live { background: var(--wash); color: var(--on-wash); }
  .status.live::before { background: var(--primary); animation: pulse 1.6s ease-out infinite; }
  .status.full { color: var(--error); }
  @keyframes pulse { from { box-shadow: 0 0 0 0 var(--primary); } to { box-shadow: 0 0 0 6px transparent; } }
  h1 { margin: 0; font-size: 24px; line-height: 1.25; font-weight: 600; overflow-wrap: anywhere;
       display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { margin-top: 6px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .room { margin-top: 24px; padding: 16px; border-radius: 20px; background: var(--high); }
  .who { display: flex; justify-content: center; align-items: center; gap: 8px; color: var(--muted); }
  .who strong { color: var(--text); font-weight: 600; }
  .seats { display: flex; justify-content: center; gap: 6px; margin-top: 12px; }
  .seats i { flex: 0 1 10px; aspect-ratio: 1; border-radius: 50%; background: var(--line); }
  .seats i.on { background: var(--primary); }
  .host { margin-top: 12px; font-size: 14px; color: var(--muted); }
  .host strong { color: var(--text); font-weight: 500; }
  .note { margin-top: 12px; font-size: 14px; color: var(--muted); }
  .open { display: block; width: 100%; margin-top: 24px; padding: 14px 24px; border: 0; border-radius: 999px; background: var(--primary);
          color: var(--on-primary); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer;
          transition: filter .2s, transform .14s cubic-bezier(.33, 1, .68, 1); }
  .open:not(:disabled):hover { filter: brightness(1.08); }
  .open:not(:disabled):active { transform: scale(.97); }
  .open:disabled { background: var(--high); color: var(--muted); cursor: not-allowed; }
  a:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
  .hint { margin-top: 12px; font-size: 14px; color: var(--muted); }
  .gone { display: grid; place-items: center; width: 72px; height: 72px; margin: 4px auto 20px; border-radius: 50%; background: var(--high); color: var(--primary); }
  .gone svg { width: 32px; height: 32px; }
  .lead { margin-top: 8px; color: var(--muted); }
  footer { margin-top: 20px; padding-top: 16px; border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent); font-size: 14px; color: var(--muted); }
  footer a { color: var(--primary); font-weight: 500; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  @media (prefers-reduced-motion: reduce) { *, ::before { animation: none !important; transition: none !important; } }
`;

// Opens the app; built from the page's own address, which the server may not know behind a proxy.
const OPEN_SCRIPT = `<script>
  const path = location.pathname;
  const at = path.lastIndexOf("/party/");
  const query = "party?server=" + encodeURIComponent(location.origin + path.slice(0, at)) +
    "&id=" + encodeURIComponent(path.slice(at + 7).split("/")[0]);
  document.getElementById("open").href = /Android/.test(navigator.userAgent)
    ? "intent://" + query + "#Intent;scheme=aikatsu;S.browser_fallback_url=" + encodeURIComponent("${RELEASES}") + ";end"
    : "aikatsu://" + query;
</script>`;

const partyHtml = (title: string, body: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Aikatsu</title>
<style>${PARTY_STYLE}</style>
<main>
  <p class="eyebrow">Aikatsu · Watch together</p>
  ${body}
  <footer><a href="${RELEASES}">Get Aikatsu</a></footer>
</main>
</html>
`;

const ENDED_PAGE = partyHtml(
  "Party ended",
  `<div class="gone">${ICON_MOON}</div>
  <h1>This party has ended</h1>
  <p class="lead">Ask the host for a new link.</p>`,
);

function partyPage(p: Party) {
  const { anime, episode, paused, position, speed, at } = p.state;
  const watching = p.listeners.size;
  const full = watching >= PARTY_MEMBERS;
  const playing = watching > 0 && !paused;
  const livePosition = playing ? position + ((Date.now() - at) / 1000) * speed : position;
  const left = Math.min(p.created + PARTY_MAX_AGE, p.emptySince ? p.emptySince + PARTY_EMPTY_TTL : Infinity) - now();
  const [status, label] = full ? ["full", "Full"] : watching ? ["live", "Live"] : ["waiting", "Waiting"];
  const seatsLeft = PARTY_MEMBERS - watching;
  const name = anime.name || "Untitled";
  const poster = /^https:\/\//.test(anime.image) ? `<img src="${escapeHtml(anime.image)}" alt="" referrerpolicy="no-referrer">` : "";
  return partyHtml(
    `Watch ${name} together`,
    `<div class="poster">${ICON_TV}${poster}</div>
  <span class="status ${status}">${label}</span>
  <h1>${escapeHtml(name)}</h1>
  <p class="meta">Episode ${episode} · ${clock(livePosition)} · ${playing ? "Playing" : "Paused"}</p>
  <div class="room">
    <p class="who">${ICON_PEOPLE}${watching
      ? `<span><strong>${watching} watching</strong>${full ? "" : ` · ${seatsLeft} ${seatsLeft === 1 ? "seat" : "seats"} left`}</span>`
      : `<span>No one here yet</span>`}</p>
    <div class="seats" role="img" aria-label="${watching} of ${PARTY_MEMBERS} seats taken">${
      Array.from({ length: PARTY_MEMBERS }, (_, i) => (i < watching ? `<i class="on"></i>` : "<i></i>")).join("")}</div>
    <p class="host">Hosted by <strong>${escapeHtml(p.hostName)}</strong></p>
  </div>
  ${left < 3600 ? `<p class="note">Closes in ${Math.max(1, Math.ceil(left / 60))} min</p>` : ""}
  ${full ? `<button class="open" id="open" disabled>Party full</button>` : `<a class="open" id="open" href="#">Join in Aikatsu</a>`}
  <p class="hint">Sign in to Aikatsu first.</p>
  ${OPEN_SCRIPT}`,
  );
}

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
      ({ params }) => {
        sweepParties();
        const p = parties.get(params.id);
        return new Response(p ? partyPage(p) : ENDED_PAGE, {
          status: p ? 200 : 404,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https:",
          },
        });
      },
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
              hostName: user.username,
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
