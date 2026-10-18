import { connect, DEFAULT_DATABASE_URL } from "./db";

const [command, name] = process.argv.slice(2);
if (command !== "reset-password" || !name) {
  console.error("usage: bun src/cli.ts reset-password <username>");
  process.exit(1);
}
const sql = await connect(process.env.DATABASE_URL || DEFAULT_DATABASE_URL);
const password = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
const hash = await Bun.password.hash(password);
const user = await sql.begin(async (tx) => {
  const [user] = await tx`UPDATE users SET password_hash = ${hash}
                           WHERE username = ${name.trim().toLowerCase()} RETURNING id`;
  if (user) await tx`DELETE FROM sessions WHERE user_id = ${user.id}`;
  return user;
});
if (!user) {
  console.error(`No user named ${name}.`);
  process.exit(1);
}
console.log(`New password for ${name}: ${password}`);
await sql.close();
