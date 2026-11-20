import { createHash } from "node:crypto";

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(item => canonicalJSON(item ?? null)).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().filter(key => object[key] !== undefined)
      .map(key => JSON.stringify(key) + ":" + canonicalJSON(object[key])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}
export function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}
