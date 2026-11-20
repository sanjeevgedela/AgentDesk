import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { newDesk, type Desk } from "./engine";

const connection = process.env.DATABASE_URL;
const sql = connection ? postgres(connection, { max: 3, prepare: false }) : undefined;
const folder = join(process.cwd(), ".agentdesk");
let queue = Promise.resolve<unknown>(undefined);

export async function transact<T>(owner: string, fn: (desk: Desk) => T | Promise<T>): Promise<T> {
  if (sql) return sql.begin(async tx => {
    await tx`insert into agentdesk_workspace (owner,state) values (${owner},${tx.json(JSON.parse(JSON.stringify(newDesk())))}) on conflict do nothing`;
    const [row] = await tx`select state from agentdesk_workspace where owner = ${owner} for update`;
    const desk = row.state as Desk;
    const result = await fn(desk);
    await tx`update agentdesk_workspace set state = ${tx.json(JSON.parse(JSON.stringify(desk)))}, updated_at = now() where owner = ${owner}`;
    return result;
  }) as Promise<T>;

  if (process.env.VERCEL) throw new Error("Set DATABASE_URL and apply the migration for hosted use.");
  const operation = queue.then(async () => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, owner + ".json");
    let desk: Desk;
    try { desk = JSON.parse(await readFile(file, "utf8")); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      desk = newDesk();
    }
    const result = await fn(desk);
    await writeFile(file + ".tmp", JSON.stringify(desk), { mode: 0o600 });
    await rename(file + ".tmp", file);
    return result;
  });
  queue = operation.catch(() => undefined);
  return operation;
}

export function operator(token: string | null) {
  const secret = process.env.AGENTDESK_OPERATOR_TOKEN;
  if (!secret || secret.length < 32 || !token) return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(token), hash("Bearer " + secret));
}
