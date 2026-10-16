import { Elysia, t } from "elysia";
import type { SQL, Server } from "bun";

export interface Config {
  allowRegistration: boolean;
  /** Read the client IP from the X-Forwarded-For entry the proxy appended. */
  trustProxy: boolean;
  maxRecordsPerUser: number;
}

/** Seconds a session may go unused. */
export const SESSION_IDLE = 180 * 86400;
const PUSH_LIMIT = 500;
const PULL_LIMIT = 1000;
const MAX_DATA_BYTES = 16 * 1024;

export const now = () => Math.floor(Date.now() / 1000);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

// ponytail: per-process memory; move counters to the database or Redis to run several replicas.
function limiter(max: number, windowSeconds: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  const live = (key: string) => {
    const h = hits.get(key);
    return h && h.reset > now() ? h : undefined;
  };
  return {
    blocked: (key: string) => (live(key)?.n ?? 0) >= max,
    /** True once over the limit. */
    count(key: string): boolean {
      if (hits.size > 10_000) for (const [k, h] of hits) if (h.reset <= now()) hits.delete(k);
      const h = live(key) ?? { n: 0, reset: now() + windowSeconds };
      h.n++;
      hits.set(key, h);
      return h.n > max;
    },
    clear: (key: string) => void hits.delete(key),
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
  const newAccounts = limiter(5, 3600); // per IP, successful sign-ups
  const nameFailures = limiter(10, 900); // per username, wrong passwords
  const ipFailures = limiter(50, 900); // per IP, wrong passwords
  const requests = limiter(120, 60); // per user, signed-in requests

  const ipOf = (request: Request, server: Server<unknown> | null) => {
    const forwarded = config.trustProxy && request.headers.get("x-forwarded-for");
    return forwarded ? forwarded.split(",").at(-1)!.trim() : (server?.requestIP(request)?.address ?? "unknown");
  };

  async function createSession(userId: string, device = "") {
    const token = randomToken(32);
    await sql`INSERT INTO sessions (token_hash, user_id, device, created_at, last_used_at)
              VALUES (${sha256(token)}, ${userId}, ${device}, ${now()}, ${now()})`;
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
    if (nameFailures.blocked(user.username) || ipFailures.blocked(ip)) fail(429, "Too many wrong passwords. Try again in 15 minutes.");
    if (await Bun.password.verify(password, user.passwordHash)) return;
    nameFailures.count(user.username);
    ipFailures.count(ip);
    fail(403, "Wrong password.");
  }

  return new Elysia({ serve: { maxRequestBodySize: 2 * 1024 * 1024 } })
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
    .post(
      "/auth/register",
      async ({ body, request, server, set }) => {
        if (!config.allowRegistration) fail(403, "Sign-ups are closed.");
        const ip = ipOf(request, server);
        if (newAccounts.blocked(ip)) fail(429, "Too many sign-ups. Try again later.");
        const username = checkUsername(body.username);
        checkPassword(body.password);
        // Checked before hashing so taken names cost nothing; ON CONFLICT covers the race.
        const [taken] = await sql`SELECT 1 FROM users WHERE username = ${username}`;
        if (taken) fail(409, "Username is taken.");
        const id = Bun.randomUUIDv7();
        const created = await sql`INSERT INTO users (id, username, password_hash, created_at)
                                  VALUES (${id}, ${username}, ${await Bun.password.hash(body.password)}, ${now()})
                                  ON CONFLICT (username) DO NOTHING RETURNING id`;
        if (!created.length) fail(409, "Username is taken.");
        newAccounts.count(ip);
        set.status = 201;
        return { token: await createSession(id, body.device), username };
      },
      { body: credentials },
    )
    .post(
      "/auth/login",
      async ({ body, request, server }) => {
        const username = body.username.trim().toLowerCase();
        const ip = ipOf(request, server);
        if (nameFailures.blocked(username) || ipFailures.blocked(ip)) fail(429, "Too many failed sign-ins. Try again in 15 minutes.");
        const [user] = await sql`SELECT id, password_hash FROM users WHERE username = ${username}`;
        const ok = await Bun.password.verify(body.password, user?.password_hash ?? (await dummyHash));
        if (!user || !ok) {
          nameFailures.count(username);
          ipFailures.count(ip);
          fail(401, "Wrong username or password.");
        }
        nameFailures.clear(username);
        return { token: await createSession(user.id, body.device), username };
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
            await sql.begin(async (tx) => {
              await tx`UPDATE users SET password_hash = ${await Bun.password.hash(body.password)} WHERE id = ${user.id}`;
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
                // ponytail: clamps clocks running ahead; a device whose clock is far behind loses every conflict.
                return { user_id: user.id, kind: c.kind, key: c.key, data, updated_at: Math.min(c.updatedAt, now() + 60), deleted: c.deleted ? 1 : 0, seq: 0 };
              });
              await sql.begin(async (tx) => {
                // Locks the user row until commit, so one user's writes commit in seq order and a pull never skips one.
                const [{ seq }] = await tx`UPDATE users SET seq = seq + ${rows.length} WHERE id = ${user.id} RETURNING seq`;
                // ponytail: counts updates as new records, so a user at the cap can't sync anything; count new keys only if that bites.
                const [{ n }] = await tx`SELECT COUNT(*) AS n FROM records WHERE user_id = ${user.id}`;
                if (Number(n) + rows.length > config.maxRecordsPerUser) fail(413, "Storage limit reached.");
                rows.forEach((r, i) => (r.seq = Number(seq) - rows.length + i + 1));
                const accepted = new Set(
                  (await tx`INSERT INTO records ${sql(rows)}
                            ON CONFLICT (user_id, kind, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
                              deleted = excluded.deleted, seq = excluded.seq
                            WHERE excluded.updated_at > records.updated_at
                            RETURNING kind, key`).map(id),
                );
                // The stored record beat these; send it back even if the client's cursor is already past it.
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
        ),
    );
}
