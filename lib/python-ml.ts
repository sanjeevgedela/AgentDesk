import { spawn } from "node:child_process";
import { join } from "node:path";

export function pythonML<T>(payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.AGENTDESK_PYTHON || "python3", [join(process.cwd(), "scripts/learn.py")], {
      timeout: 20_000, env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
    child.stderr.resume();
    child.stdin.on("error", reject);
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error("Python ML unavailable. Install requirements-ml.txt."));
      try { resolve(JSON.parse(output) as T); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
