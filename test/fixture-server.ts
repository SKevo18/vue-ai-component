import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const FIXTURE_TOKEN = "otter-token";
const MCP_DIR = join(import.meta.dirname, "mcp-server");
const GO_DIR = join(import.meta.dirname, "..", "go");

export function hasGo(): boolean {
  return spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
}

export interface Fixture {
  url: string;
  stop(): Promise<void>;
}

/** builds the Go package `pkg` in `dir`, runs it with `args` and waits for its "listening <url>" line */
async function startGo(dir: string, pkg: string, args: string[]): Promise<Fixture> {
  const bin = join(mkdtempSync(join(tmpdir(), "go-fixture-")), "fixture");
  const build = spawnSync("go", ["build", "-o", bin, pkg], { cwd: dir, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`go build failed: ${build.stderr}`);
  const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"] });
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
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill("SIGTERM");
      await exited.promise;
    },
  };
}

/** the MCP fixture server of test/mcp-server */
export function startFixture(addr = "127.0.0.1:0"): Promise<Fixture> {
  return startGo(MCP_DIR, ".", ["-addr", addr, "-token", FIXTURE_TOKEN]);
}

/** the aiserver handler with fake vendors, go/internal/aifixture */
export function startAiFixture(): Promise<Fixture> {
  return startGo(GO_DIR, "./internal/aifixture", ["-addr", "127.0.0.1:0"]);
}
