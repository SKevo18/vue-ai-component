import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const FIXTURE_TOKEN = "otter-token";
const DIR = join(import.meta.dirname, "mcp-server");

export function hasGo(): boolean {
  return spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
}

export interface Fixture {
  url: string;
  stop(): Promise<void>;
}

export async function startFixture(addr = "127.0.0.1:0"): Promise<Fixture> {
  const bin = join(mkdtempSync(join(tmpdir(), "mcp-fixture-")), "fixture");
  const build = spawnSync("go", ["build", "-o", bin, "."], { cwd: DIR, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);
  const child: ChildProcess = spawn(bin, ["-addr", addr, "-token", FIXTURE_TOKEN], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout! });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  lines.once("line", (line) => {
    const m = /^listening (\S+)$/.exec(line.trim());
    if (m) resolve(m[1]!);
    else reject(new Error(`unexpected fixture output: ${line}`));
  });
  child.once("exit", (code) => reject(new Error(`fixture exited with ${code}`)));
  const url = await promise;
  return {
    url,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    },
  };
}
