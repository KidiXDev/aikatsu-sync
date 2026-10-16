import { createApp, now, SESSION_IDLE } from "./app";
import { connect, DEFAULT_DATABASE_URL } from "./db";

const env = process.env;
const sql = await connect(env.DATABASE_URL || DEFAULT_DATABASE_URL);
const app = createApp(sql, {
  allowRegistration: env.ALLOW_REGISTRATION !== "false",
  trustProxy: env.TRUST_PROXY === "true",
  maxRecordsPerUser: Number(env.MAX_RECORDS_PER_USER) || 100_000,
}).listen(Number(env.PORT) || 3000);

console.log(`aikatsu-sync listening on port ${app.server?.port}`);

const pruneSessions = () => sql`DELETE FROM sessions WHERE last_used_at < ${now() - SESSION_IDLE}`.catch(console.error);
pruneSessions();
setInterval(pruneSessions, 3600_000);
