// SQLite in memory by default; set TEST_DATABASE_URL=postgres://… to run the same suite on Postgres.
import { beforeAll, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { type Config, createApp } from "./app";
import { connect } from "./db";

let sql: SQL;
const config: Config = { allowRegistration: true, trustProxy: true, maxRecordsPerUser: 5000 };
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL ?? ":memory:";
  if (url !== ":memory:") {
    const old = await connect(url);
    for (const table of ["records", "sessions", "users"]) await old.unsafe(`DROP TABLE IF EXISTS ${table}`);
    await old.close();
  }
  sql = await connect(url);
  app = createApp(sql, config);
});

let n = 0;
const unique = () => `user${++n}${Date.now() % 100000}`;

async function req(path: string, body?: unknown, token?: string, target = app, ip = `198.51.100.${n++ % 250}`) {
  const res = await target.handle(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `203.0.113.7, ${ip}`,
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function account(target = app) {
  const username = unique();
  const r = await req("/auth/register", { username, password: "hunter2hunter2" }, undefined, target);
  expect(r.status).toBe(201);
  return { username, token: r.json.token as string };
}

const progress = (key: string, updatedAt: number, data: unknown = { pos: updatedAt }) => ({ kind: "progress", key, updatedAt, data });

test("health", async () => {
  expect(await req("/health")).toEqual({ status: 200, json: { ok: true } });
});

test("register, login, logout", async () => {
  const { username, token } = await account();
  expect((await req("/auth/register", { username: username.toUpperCase(), password: "hunter2hunter2" })).status).toBe(409);
  expect((await req("/auth/register", { username: "x", password: "hunter2hunter2" })).status).toBe(422);
  expect((await req("/auth/register", { username: unique(), password: "short" })).status).toBe(422);
  expect((await req("/auth/login", { username, password: "wrong-password" })).json.error).toBe("Wrong username or password.");
  expect((await req("/auth/login", { username: "nobody-here", password: "wrong-password" })).status).toBe(401);
  const login = await req("/auth/login", { username: ` ${username.toUpperCase()} `, password: "hunter2hunter2" });
  expect(login.status).toBe(200);
  expect(login.json.username).toBe(username);

  expect((await req("/sync", { cursor: 0, changes: [] }, token)).status).toBe(200);
  expect((await req("/auth/logout", {}, token)).status).toBe(204);
  expect((await req("/sync", { cursor: 0, changes: [] }, token)).status).toBe(401);
  expect((await req("/sync", { cursor: 0, changes: [] }, login.json.token)).status).toBe(200);
  expect((await req("/sync", { cursor: 0, changes: [] })).status).toBe(401);
});

test("sign-ups are limited per address, taken from the proxy's entry", async () => {
  const fresh = createApp(sql, config);
  const signUp = () => req("/auth/register", { username: unique(), password: "hunter2hunter2" }, undefined, fresh, "192.0.2.1");
  for (let i = 0; i < 5; i++) expect((await signUp()).status).toBe(201);
  expect((await signUp()).status).toBe(429);
  expect((await req("/auth/register", { username: unique(), password: "hunter2hunter2" }, undefined, fresh, "192.0.2.2")).status).toBe(201);
});

test("closed registration", async () => {
  const closed = createApp(sql, { ...config, allowRegistration: false });
  expect((await req("/auth/register", { username: unique(), password: "hunter2hunter2" }, undefined, closed)).status).toBe(403);
});

test("last write wins, deletions, and rejected changes come back", async () => {
  const { token } = await account();
  let r = await req("/sync", { cursor: 0, changes: [progress("a", 100), progress("b", 100), { kind: "setting", key: "quality", updatedAt: 0, data: "720p" }] }, token);
  expect(r.json.changes.length).toBe(3);
  const cursor = r.json.cursor;

  r = await req("/sync", { cursor, changes: [progress("a", 50), progress("b", 200), progress("b", 150)] }, token);
  const byKey = Object.fromEntries(r.json.changes.map((c: { key: string }) => [c.key, c]));
  expect(byKey.a).toEqual({ kind: "progress", key: "a", updatedAt: 100, deleted: false, data: { pos: 100 } });
  expect(byKey.b.updatedAt).toBe(200);
  expect(r.json.changes.length).toBe(2);

  r = await req("/sync", { cursor: r.json.cursor, changes: [{ kind: "progress", key: "a", updatedAt: 300, deleted: true, data: { ignored: 1 } }] }, token);
  expect(r.json.changes).toEqual([{ kind: "progress", key: "a", updatedAt: 300, deleted: true, data: null }]);

  r = await req("/sync", { cursor: 0, changes: [] }, token);
  expect(r.json.changes.map((c: { key: string; updatedAt: number }) => `${c.key}@${c.updatedAt}`).sort()).toEqual(["a@300", "b@200", "quality@0"]);
  expect(r.json.more).toBe(false);
});

test("clocks far ahead are clamped", async () => {
  const { token } = await account();
  const r = await req("/sync", { cursor: 0, changes: [progress("a", 4_000_000_000)] }, token);
  expect(r.json.changes[0].updatedAt).toBeLessThan(Date.now() / 1000 + 120);
});

test("accounts are separate", async () => {
  const a = await account();
  const b = await account();
  await req("/sync", { cursor: 0, changes: [progress("x", 1)] }, a.token);
  expect((await req("/sync", { cursor: 0, changes: [] }, b.token)).json.changes).toEqual([]);
});

test("pull pages by cursor", async () => {
  const { token } = await account();
  for (let i = 0; i < 3; i++)
    await req("/sync", { cursor: 0, changes: Array.from({ length: 400 }, (_, j) => progress(`k${i * 400 + j}`, 1)) }, token);
  let r = await req("/sync", { cursor: 0, changes: [] }, token);
  expect([r.json.changes.length, r.json.more]).toEqual([1000, true]);
  r = await req("/sync", { cursor: r.json.cursor, changes: [] }, token);
  expect([r.json.changes.length, r.json.more]).toEqual([200, false]);
});

test("limits", async () => {
  const { token } = await account();
  const tooMany = Array.from({ length: 501 }, (_, i) => progress(`k${i}`, 1));
  expect((await req("/sync", { cursor: 0, changes: tooMany }, token)).status).toBe(422);
  expect((await req("/sync", { cursor: 0, changes: [progress("big", 1, "x".repeat(17_000))] }, token)).status).toBe(413);
  expect((await req("/sync", { cursor: 0, changes: [{ ...progress("a", 1), kind: "Bad Kind" }] }, token)).status).toBe(422);

  const capped = createApp(sql, { ...config, maxRecordsPerUser: 3 });
  const c = await account(capped);
  expect((await req("/sync", { cursor: 0, changes: [progress("1", 1), progress("2", 1), progress("3", 1)] }, c.token, capped)).status).toBe(200);
  const over = await req("/sync", { cursor: 0, changes: [progress("4", 1)] }, c.token, capped);
  expect(over.status).toBe(413);
  expect((await req("/sync", { cursor: 0, changes: [] }, c.token, capped)).json.changes.length).toBe(3);
});

test("wrong passwords are rate limited per username", async () => {
  const fresh = createApp(sql, config);
  const { username } = await account(fresh);
  for (let i = 0; i < 10; i++) expect((await req("/auth/login", { username, password: "nope-nope" }, undefined, fresh)).status).toBe(401);
  const r = await req("/auth/login", { username, password: "hunter2hunter2" }, undefined, fresh);
  expect(r.status).toBe(429);
});

test("signed-in requests are rate limited per user", async () => {
  const fresh = createApp(sql, config);
  const { token } = await account(fresh);
  const statuses = [];
  for (let i = 0; i < 121; i++) statuses.push((await req("/sync", { cursor: 0, changes: [] }, token, fresh)).status);
  expect(statuses.at(-2)).toBe(200);
  expect(statuses.at(-1)).toBe(429);
});

test("changing the password signs out other devices", async () => {
  const { username, token } = await account();
  const other = (await req("/auth/login", { username, password: "hunter2hunter2" })).json.token;
  expect((await req("/account/password", { current: "wrong-one", password: "new-password-1" }, token)).status).toBe(403);
  expect((await req("/account/password", { current: "hunter2hunter2", password: "new-password-1" }, token)).status).toBe(204);
  expect((await req("/sync", { cursor: 0, changes: [] }, other)).status).toBe(401);
  expect((await req("/sync", { cursor: 0, changes: [] }, token)).status).toBe(200);
  expect((await req("/auth/login", { username, password: "new-password-1" })).status).toBe(200);
});

test("deleting the account removes its data", async () => {
  const { username, token } = await account();
  await req("/sync", { cursor: 0, changes: [progress("x", 1)] }, token);
  expect((await req("/account/delete", { password: "hunter2hunter2" }, token)).status).toBe(204);
  expect((await req("/sync", { cursor: 0, changes: [] }, token)).status).toBe(401);
  expect((await req("/auth/login", { username, password: "hunter2hunter2" })).status).toBe(401);
  const [{ n }] = await sql`SELECT COUNT(*) AS n FROM records r WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)`;
  expect(Number(n)).toBe(0);
});

test("accounts at their record limit can still update and delete existing records", async () => {
  const capped = createApp(sql, { ...config, maxRecordsPerUser: 1 });
  const { token } = await account(capped);
  expect((await req("/sync", { cursor: 0, changes: [progress("only", 1)] }, token, capped)).status).toBe(200);
  expect((await req("/sync", { cursor: 0, changes: [progress("only", 2)] }, token, capped)).status).toBe(200);
  expect((await req("/sync", { cursor: 0, changes: [{ ...progress("only", 3), deleted: true }] }, token, capped)).status).toBe(200);
  expect((await req("/sync", { cursor: 0, changes: [progress("new", 4)] }, token, capped)).status).toBe(413);
});

test("simultaneous sign-ups cannot bypass the address limit", async () => {
  const fresh = createApp(sql, config);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    req("/auth/register", { username: unique(), password: "hunter2hunter2" }, undefined, fresh, "192.0.2.80"),
  ));
  expect(results.filter((r) => r.status === 201).length).toBeLessThanOrEqual(5);
  expect(results.some((r) => r.status === 429)).toBe(true);
});


test("parallel password attempts are bounded before verification", async () => {
  const fresh = createApp(sql, config);
  const { username } = await account(fresh);
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    req("/auth/login", { username, password: "wrong-password" }, undefined, fresh, "192.0.2.90"),
  ));
  expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10);
  expect(results.some((r) => r.status === 429)).toBe(true);
  expect(results.every((r) => r.status === 401 || r.status === 429)).toBe(true);
});

test("a login using an old password cannot issue a session after a reset", async () => {
  const { username, token } = await account();
  const passwordHash = await Bun.password.hash("replacement-password");
  const original = Bun.password.verify;
  const mock = spyOn(Bun.password, "verify").mockImplementation(async (password, hash, algorithm) => {
    await sql.begin(async (tx) => {
      const [user] = await tx`UPDATE users SET password_hash = ${passwordHash} WHERE username = ${username} RETURNING id`;
      await tx`DELETE FROM sessions WHERE user_id = ${user.id}`;
    });
    return original(password, hash, algorithm);
  });
  try {
    expect((await req("/auth/login", { username, password: "hunter2hunter2" })).status).toBe(401);
  } finally { mock.mockRestore(); }
  expect((await req("/sync", { cursor: 0, changes: [] }, token)).status).toBe(401);
  expect((await req("/auth/login", { username, password: "replacement-password" })).status).toBe(200);
});
