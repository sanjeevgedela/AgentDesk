export type Stage = { name: "schema" | "policy" | "risk" | "simulate" | "execute" | "reconcile"; ok: boolean; detail: string; at: string };
type Check = { name: Stage["name"]; check: () => Omit<Stage, "name" | "at"> };
export function runPipeline({ at, checks }: { at: string; checks: Check[] }) {
  const stages: Stage[] = [];
  for (const { name, check } of checks) {
    const result = check();
    stages.push({ name, at, ...result });
    if (!result.ok) break;
  }
  return stages;
}
