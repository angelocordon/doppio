import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandFor, run } from "./doppio";

const directory = mkdtempSync(join(tmpdir(), "doppio-test-"));
afterAll(() => rmSync(directory, { recursive: true }));
const variants = [["source", [process.execPath, join(import.meta.dir, "doppio.ts")]]] as
  [string, string[]][];
if (process.env.DOPPIO_BINARY) variants.push(["compiled", [resolve(process.env.DOPPIO_BINARY)]]);

test("hours and minutes become exact caffeinate seconds", () => {
  for (const [duration, seconds] of [
    ["30m", "1800"], ["1h", "3600"], ["1h30m", "5400"], ["90m", "5400"],
    ["0h30m", "1800"], ["1h0m", "3600"], ["2h90m", "12600"],
    ["0001m", "60"], ["35791394m", "2147483640"], ["596523h14m", "2147483640"],
  ]) {
    expect(commandFor([duration])).toEqual(["/usr/bin/caffeinate", "-i", "-t", seconds]);
    expect(commandFor(["-d", duration])).toEqual(["/usr/bin/caffeinate", "-i", "-d", "-t", seconds]);
  }
});

const invalid = [
  [], ["-d"], ["0m"], ["0h"], ["0h0m"], ["1"], ["1s"], ["1ms"], ["1h1s"],
  ["1.5h"], ["-1m"], ["+1m"], ["30m1h"], ["1h2h"], ["1m2m"], ["1H"],
  ["1m "], [" 1m"], [""], ["1m\n"], ["1m", "2m"], ["-x", "1m"],
  ["1m", "-d"], ["-d", "-d", "1m"], ["--display", "1m"], ["status"],
  ["--help", "1m"], ["35791395m"], ["596524h"], ["9".repeat(400) + "h"],
  ["1h;echo nope"],
];

test("reject invalid input and unsafe or overflowing totals", () => {
  for (const args of invalid) expect(() => commandFor(args)).toThrow("invalid duration");
});

test("help needs no child", () => {
  expect(commandFor(["-h"])).toBeNull();
  expect(commandFor(["--help"])).toBeNull();
});

test("supported subprocess API propagates natural child exits and launch errors", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  for (const code of [0, 37]) {
    expect(await run([process.execPath, "-e", `process.exit(${code})`])).toBe(code);
  }
  await expect(run([join(directory, "nonexistent")])).rejects.toThrow();
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

for (const [name, command] of variants) {
  describe(name, () => {
    test("help and invalid arguments have the documented exit codes", () => {
      for (const flag of ["-h", "--help"]) {
        const result = Bun.spawnSync([...command, flag]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain("Ctrl-C");
      }
      for (const args of invalid) {
        const result = Bun.spawnSync([...command, ...args]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr.toString()).toContain("Usage:");
      }
    });
  });
}

if (process.env.DOPPIO_BINARY) {
  test("compiled dop symlink uses the same CLI", () => {
    const alias = join(directory, "dop");
    symlinkSync(resolve(process.env.DOPPIO_BINARY!), alias);
    expect(Bun.spawnSync([alias, "--help"]).stdout.toString()).toContain("Usage: doppio");
    expect(Bun.spawnSync([alias, "1ms"]).exitCode).toBe(2);
  });
}

function exists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function childOf(pid: number, name?: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(pid), ...(name ? ["-x", name] : [])]);
    if (result.exitCode === 0) return Number(result.stdout.toString().trim().split("\n")[0]);
    if (result.exitCode !== 1) throw new Error(`pgrep failed: ${result.stderr}`);
    await Bun.sleep(20);
  }
  throw new Error(`No child of owned process ${pid}`);
}

const realTests = process.env.DOPPIO_REAL_TESTS === "1" && process.platform === "darwin";
if (realTests) {
  // Keep PATH hostile: production must use macOS's executable, not this fake.
  writeFileSync(join(directory, "caffeinate"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  for (const [name, command] of variants) {
    for (const display of [false, true]) {
      for (const terminal of [false, true]) {
        test(`${name}: ${display ? "display + idle" : "idle"}; ${terminal ? "terminal Ctrl-C" : "wrapper-only SIGTERM"}`, async () => {
          const args = [...command, ...(display ? ["-d"] : []), "1m"];
          const errors = join(directory, `${name}-${display}-${terminal}.stderr`);
          const invocation = terminal ? [
            // script needs real pipes/files, not Bun's socket-backed stdio.
            "/bin/sh", "-c",
            'errors=$1; shift; (/bin/sleep 2; /usr/bin/printf "\\003") | /usr/bin/script -q /dev/null "$@" > /dev/null 2> "$errors"',
            "doppio-test", errors, ...args,
          ] : args;
          const wrapper = Bun.spawn(invocation, {
            stdin: "ignore", stdout: "ignore", stderr: Bun.file(errors),
            env: { ...process.env, PATH: directory },
            timeout: 5_000,
          });
          let child: number | undefined;
          try {
            const script = terminal ? await childOf(wrapper.pid, "script") : undefined;
            const wrapperPid = script !== undefined ? await childOf(script) : wrapper.pid;
            child = await childOf(wrapperPid);
            await Bun.sleep(150);
            const ps = Bun.spawnSync(["/bin/ps", "-p", String(child), "-o", "command="]);
            expect(ps.stdout.toString().trim()).toBe(`/usr/bin/caffeinate -i ${display ? "-d " : ""}-t 60`);
            const assertions = Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]).stdout.toString();
            const own = assertions.split("\n").filter(line => line.includes(`pid ${child}(`)).join("\n");
            expect(own).toContain("PreventUserIdleSystemSleep");
            expect(own.includes("PreventUserIdleDisplaySleep")).toBe(display);
            if (!terminal) wrapper.kill("SIGTERM");
            expect(await wrapper.exited).toBe(terminal ? 130 : 143);
            expect(exists(child)).toBe(false);
          } finally {
            if (child !== undefined && exists(child)) process.kill(child, "SIGKILL");
            if (wrapper.exitCode === null) wrapper.kill("SIGTERM");
            await wrapper.exited;
            const stderr = await Bun.file(errors).text();
            if (stderr) console.error(stderr);
          }
        }, 10_000);
      }
    }
  }

  test("real caffeinate completes its own one-minute timeout", async () => {
    const command = variants.at(-1)![1];
    const wrapper = Bun.spawn([...command, "1m"], { stdout: "pipe", stderr: "pipe", timeout: 65_000 });
    let child: number | undefined;
    const started = performance.now();
    try {
      child = await childOf(wrapper.pid);
      expect(await wrapper.exited).toBe(0);
      expect(performance.now() - started).toBeGreaterThanOrEqual(59_000);
      expect(exists(child)).toBe(false);
      expect(await new Response(wrapper.stderr).text()).toBe("");
    } finally {
      if (child !== undefined && exists(child)) process.kill(child, "SIGKILL");
      if (wrapper.exitCode === null) wrapper.kill("SIGTERM");
      await wrapper.exited;
    }
  }, 70_000);
}
