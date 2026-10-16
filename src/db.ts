import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DATABASE_URL = "sqlite://data/aikatsu-sync.db";

// Runs on both databases: text ids (no autoincrement) and plain types. `data` is
// the app's JSON, never read here, so app changes need no server update.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT   PRIMARY KEY,
    username      TEXT   NOT NULL UNIQUE,
    password_hash TEXT   NOT NULL,
    seq           BIGINT NOT NULL DEFAULT 0,
    created_at    BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT   PRIMARY KEY,
    user_id      TEXT   NOT NULL,
    device       TEXT   NOT NULL DEFAULT '',
    created_at   BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS records (
    user_id    TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    updated_at BIGINT  NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    seq        BIGINT  NOT NULL,
    PRIMARY KEY (user_id, kind, key)
  )`,
  `CREATE INDEX IF NOT EXISTS records_seq ON records (user_id, seq)`,
];

/** SQLite (`sqlite://path`, `:memory:`) or Postgres (`postgres://…`); every query runs unchanged on both. */
export async function connect(url: string): Promise<SQL> {
  const postgres = /^postgres(ql)?:\/\//.test(url);
  const sqlite = url.match(/^(?:sqlite:(?:\/\/)?|file:)(.+)$/)?.[1] ?? (url === ":memory:" ? url : undefined);
  if (!postgres && sqlite === undefined) throw new Error("DATABASE_URL must start with sqlite:// or postgres://");
  if (sqlite && sqlite !== ":memory:") mkdirSync(dirname(sqlite), { recursive: true });
  const sql = new SQL(url);
  if (!postgres) await sql`PRAGMA journal_mode = WAL`;
  for (const statement of SCHEMA) await sql.unsafe(statement);
  return sql;
}
