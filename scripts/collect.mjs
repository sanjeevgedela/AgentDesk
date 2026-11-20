import { setTimeout as delay } from "node:timers/promises";

const url = new URL("/api/tick", process.env.AGENTDESK_URL || "http://localhost:3000");
const secret = process.env.CRON_SECRET || process.env.AGENTDESK_OPERATOR_TOKEN;
if (!secret) throw new Error("Set CRON_SECRET or AGENTDESK_OPERATOR_TOKEN in the environment.");

while (true) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(55_000) });
    if (res.status === 403) throw new Error("Collector credentials were rejected.");
    if (!res.ok) throw new Error(`Collector returned HTTP ${res.status}`);
    console.log(new Date().toISOString(), await res.json());
  } catch (error) {
    if (error.message === "Collector credentials were rejected.") throw error;
    console.error(new Date().toISOString(), error.message);
  }
  await delay(Math.max(1000, 60_000 - (Date.now() - started)));
}
