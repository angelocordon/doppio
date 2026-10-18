import { afterAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { durationFor } from "./doppio";
import {
  assertionCommand, formatRemaining, remainingSeconds, runSession,
  type Action, type Assertion, type Snapshot, type View,
} from "./session";

const directory = mkdtempSync(join(tmpdir(), "doppio-test-"));
afterAll(() => rmSync(directory, { recursive: true }));
const variants = [["source", [process.execPath, join(import.meta.dir, "doppio.ts")]]] as
  [string, string[]][];
if (process.env.DOPPIO_BINARY) variants.push(["compiled", [resolve(process.env.DOPPIO_BINARY)]]);

test("hours and minutes become exact seconds", () => {
  for (const [duration, seconds] of [
    ["30m", 1800], ["1h", 3600], ["1h30m", 5400], ["90m", 5400],
    ["0h30m", 1800], ["1h0m", 3600], ["2h90m", 12600],
    ["0001m", 60], ["35791394m", 2147483640], ["596523h14m", 2147483640],
  ] as const) expect(durationFor([duration])).toBe(seconds);
});

const invalid = [
  [], ["0m"], ["0h"], ["0h0m"], ["1"], ["1s"], ["1ms"], ["1h1s"],
  ["1.5h"], ["-1m"], ["+1m"], ["30m1h"], ["1h2h"], ["1m2m"], ["1H"],
  ["1m "], [" 1m"], [""], ["1m\n"], ["1m", "2m"], ["-x", "1m"],
  ["--display", "1m"], ["status"], ["stop"], ["--help", "1m"],
  ["35791395m"], ["596524h"], ["9".repeat(400) + "h"], ["1h;echo nope"],
];
const detached = [["-d"], ["-d", "1m"], ["1m", "-d"], ["1m", "--detach"]];

test("reject invalid input and unsafe or overflowing totals", () => {
  for (const args of invalid) expect(() => durationFor(args)).toThrow("invalid duration");
  for (const args of detached) expect(() => durationFor(args)).toThrow("detachment is not implemented");
});

test("help needs no child", () => {
  expect(durationFor(["-h"])).toBeNull();
  expect(durationFor(["--help"])).toBeNull();
});

test("assertions are independent, absolute-path, owner-bound and use seconds", () => {
  for (const kind of ["system", "display"] as const) {
    expect(assertionCommand(kind, 5400)).toEqual([
      "/usr/bin/caffeinate", kind === "system" ? "-i" : "-d",
      "-w", String(process.pid), "-t", "5400",
    ]);
  }
});

test("deadline snapshots do not drift, round up, clamp, or wrap long hours", () => {
  expect(remainingSeconds(5400000, 0)).toBe(5400);
  expect(remainingSeconds(5400000, 2345)).toBe(5398);
  expect(remainingSeconds(5400000, 5399999)).toBe(1);
  expect(remainingSeconds(5400000, 5400100)).toBe(0);
  expect(formatRemaining(0)).toBe("00:00:00");
  expect(formatRemaining(3661)).toBe("01:01:01");
  expect(formatRemaining(2147483640)).toBe("596523:14:00");
});

async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

function harness() {
  let action!: (action: Action) => void;
  let closed = 0;
  const snapshots: Snapshot[] = [];
  const children: Subprocess<"ignore", "ignore", "inherit">[] = [];
  const calls: [Assertion, number][] = [];
  const view: View = {
    open(handler) { action = handler; },
    render(snapshot) { snapshots.push(snapshot); },
    close() { closed++; },
  };
  function spawn(kind: Assertion, seconds: number) {
    calls.push([kind, seconds]);
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore", stdout: "ignore", stderr: "inherit",
    });
    children.push(child);
    return child;
  }
  return {
    view, children, calls, snapshots, spawn,
    action: (key: Action) => action(key),
    get closed() { return closed; },
  };
}

test("display toggles leave the system child and original deadline intact", async () => {
  const h = harness();
  let clock = 0;
  const running = runSession(60, { view: h.view, spawnAssertion: h.spawn, now: () => clock });
  try {
    expect(h.calls).toEqual([["system", 60], ["display", 60]]);
    const system = h.children[0]!;
    clock = 1250;
    h.action("toggle");
    await until(() => h.snapshots.at(-1)?.displayAwake === false, "display did not stop");
    expect(exists(h.children[1]!.pid)).toBe(false);
    expect(exists(system.pid)).toBe(true);
    h.action("toggle");
    await until(() => h.calls.length === 3, "display did not restart");
    expect(h.calls[2]).toEqual(["display", 59]);
    expect(h.children[0]).toBe(system);
    h.action("toggle");
    h.action("toggle");
    await until(() => h.calls.length === 4, "queued toggle did not complete");
    clock = 60001;
    expect(await running).toBe(0);
    expect(h.closed).toBe(1);
    expect(h.children.every(child => !exists(child.pid))).toBe(true);
  } finally {
    h.action("stop");
    await running;
  }
});

for (const [action, code] of [["stop", 0], ["interrupt", 130]] as const) {
  test(`${action} during a toggle cleans up every child and restores the view`, async () => {
    const h = harness();
    const before = process.listenerCount("SIGINT");
    const running = runSession(60, { view: h.view, spawnAssertion: h.spawn });
    h.action("toggle");
    h.action(action);
    expect(await running).toBe(code);
    expect(h.closed).toBe(1);
    expect(h.children.every(child => !exists(child.pid))).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
}

test("partial startup and view failures clean up acquired children", async () => {
  for (const failure of ["spawn", "open", "render"] as const) {
    const h = harness();
    if (failure !== "spawn") h.view[failure] = () => { throw new Error(`failed ${failure}`); };
    await expect(runSession(60, {
      view: h.view,
      spawnAssertion: (kind, seconds) => {
        if (failure === "spawn" && kind === "display") throw new Error("failed spawn");
        return h.spawn(kind, seconds);
      },
    })).rejects.toThrow(`failed ${failure}`);
    expect(h.closed).toBe(1);
    expect(h.children.every(child => !exists(child.pid))).toBe(true);
  }
});

test("display restart failure ends the session without leaking the system assertion", async () => {
  const h = harness();
  let displayStarts = 0;
  const running = runSession(60, {
    view: h.view,
    spawnAssertion: (kind, seconds) => {
      if (kind === "display" && ++displayStarts > 1) throw new Error("display restart failed");
      return h.spawn(kind, seconds);
    },
  });
  try {
    h.action("toggle");
    await until(() => h.snapshots.at(-1)?.displayAwake === false, "display did not stop");
    h.action("toggle");
    await expect(running).rejects.toThrow("display restart failed");
    expect(h.snapshots.at(-1)?.displayAwake).toBe(false);
    expect(h.children.every(child => !exists(child.pid))).toBe(true);
    expect(h.closed).toBe(1);
  } finally {
    h.action("stop");
    await running.catch(error => {
      if (!(error instanceof Error) || error.message !== "display restart failed") throw error;
    });
  }
});

test("maximum duration uses short timer checks rather than an overflowing timeout", async () => {
  const h = harness();
  const running = runSession(2147483640, { view: h.view, spawnAssertion: h.spawn });
  try {
    await Bun.sleep(150);
    expect(h.closed).toBe(0);
    expect(h.children.every(child => exists(child.pid))).toBe(true);
    expect(h.calls).toEqual([["system", 2147483640], ["display", 2147483640]]);
  } finally {
    h.action("stop");
    expect(await running).toBe(0);
    expect(h.children.every(child => !exists(child.pid))).toBe(true);
  }
});

test("an assertion child exiting early is a failure, including exit zero", async () => {
  for (const code of [0, 37]) {
    const h = harness();
    await expect(runSession(60, {
      view: h.view,
      spawnAssertion: (kind, seconds) => kind === "system" ? h.spawn(kind, seconds) :
        Bun.spawn([process.execPath, "-e", `process.exit(${code})`], {
          stdin: "ignore", stdout: "ignore", stderr: "inherit",
        }),
    })).rejects.toThrow(`display caffeinate exited unexpectedly (status ${code})`);
    expect(exists(h.children[0]!.pid)).toBe(false);
    expect(h.closed).toBe(1);
  }
});

test("restoration failures are reported, not swallowed", async () => {
  const h = harness();
  h.view.close = () => { throw new Error("restore failed"); };
  const running = runSession(60, { view: h.view, spawnAssertion: h.spawn });
  h.action("stop");
  await expect(running).rejects.toThrow("cleanup failed: restore failed");
  expect(h.children.every(child => !exists(child.pid))).toBe(true);
});

for (const [name, command] of variants) {
  describe(name, () => {
    test("help and invalid arguments have documented exit codes", () => {
      for (const flag of ["-h", "--help"]) {
        const result = Bun.spawnSync([...command, flag]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain("Ctrl-C");
      }
      for (const args of [...invalid, ...detached]) {
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

function childrenOf(pid: number, name?: string): number[] {
  const result = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(pid), ...(name ? ["-x", name] : [])]);
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) throw new Error(`pgrep failed: ${result.stderr}`);
  return result.stdout.toString().trim().split("\n").map(Number);
}

async function childOf(pid: number, name?: string): Promise<number> {
  await until(() => childrenOf(pid, name).length > 0, `No child of owned process ${pid}`);
  return childrenOf(pid, name)[0]!;
}

function assertionsFor(pid: number) {
  const result = Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]);
  if (result.exitCode !== 0) throw new Error(`pmset failed: ${result.stderr}`);
  return result.stdout.toString().split("\n").filter(line => line.includes(`pid ${pid}(`)).join("\n");
}

const realTests = process.env.DOPPIO_REAL_TESTS === "1" && process.platform === "darwin";
if (realTests) {
  writeFileSync(join(directory, "caffeinate"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  for (const [name, command] of variants) {
    test(`${name}: plain foreground and wrapper-only SIGTERM`, async () => {
      const wrapper = Bun.spawn([...command, "1m"], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, PATH: directory }, timeout: 5000,
      });
      let children: number[] = [];
      try {
        await until(() => childrenOf(wrapper.pid).length === 2, "missing assertions");
        children = childrenOf(wrapper.pid);
        await Bun.sleep(100);
        for (const [index, type] of ["System", "Display"].entries()) {
          expect(assertionsFor(children[index]!)).toContain(`PreventUserIdle${type}Sleep`);
        }
        wrapper.kill("SIGTERM");
        expect(await wrapper.exited).toBe(143);
        expect(children.every(pid => !exists(pid))).toBe(true);
        const stdout = await new Response(wrapper.stdout).text();
        expect(stdout).toContain("00:01:00");
        expect(stdout).not.toContain("\x1b");
        expect(stdout).not.toContain("toggle");
        expect(await new Response(wrapper.stderr).text()).toBe("");
      } finally {
        if (wrapper.exitCode === null) wrapper.kill("SIGTERM");
        await wrapper.exited;
        for (const pid of children) if (exists(pid)) process.kill(pid, "SIGKILL");
      }
    }, 10000);

    for (const [ending, key, code] of [
      ["toggle twice then q", "q", 0],
      ["raw Ctrl-C", "\x03", 130],
      ["raw Ctrl-Z", "\x1a", 146],
      ["SIGTERM", "SIGTERM", 143],
      ["SIGHUP", "SIGHUP", 129],
    ] as const) {
      test(`${name}: PTY ${ending} restores input and releases assertions`, async () => {
        const output = join(directory, `${name}-${code}.stdout`);
        const errors = join(directory, `${name}-${code}.stderr`);
        const wrapper = Bun.spawn([
          "/bin/sh", "-c",
          '/bin/cat | /usr/bin/script -q /dev/null /bin/sh -c \'before=$(/bin/stty -g); "$@"; code=$?; after=$(/bin/stty -g); [ "$before" = "$after" ] || exit 97; echo DOPPIO_TTY_RESTORED; exit "$code"\' doppio-test "$@"',
          "doppio-test", ...command, "1m",
        ], {
          stdin: "pipe", stdout: Bun.file(output), stderr: Bun.file(errors),
          env: { ...process.env, PATH: directory, TERM: "xterm-256color" }, timeout: 7000,
        });
        let pids: number[] = [];
        let owner: number | undefined;
        try {
          const script = await childOf(wrapper.pid, "script");
          const shell = await childOf(script);
          owner = await childOf(shell);
          const ownerPid = owner;
          await until(() => childrenOf(ownerPid).length === 2, "missing PTY assertions");
          pids = childrenOf(ownerPid);
          const system = pids[0]!;
          await until(() => assertionsFor(system).includes("PreventUserIdleSystemSleep") &&
            assertionsFor(pids[1]!).includes("PreventUserIdleDisplaySleep"), "assertions not ready");
          expect(assertionsFor(system)).toContain("PreventUserIdleSystemSleep");
          expect(assertionsFor(pids[1]!)).toContain("PreventUserIdleDisplaySleep");
          if (code === 0) {
            wrapper.stdin.write("?");
            await wrapper.stdin.flush();
            await Bun.sleep(1100);
            wrapper.stdin.write("s");
            await wrapper.stdin.flush();
            await until(() => childrenOf(ownerPid).length === 1, "display assertion did not stop");
            expect(childrenOf(ownerPid)).toEqual([system]);
            expect(assertionsFor(system)).toContain("PreventUserIdleSystemSleep");
            wrapper.stdin.write("s");
            await wrapper.stdin.flush();
            await until(() => childrenOf(ownerPid).length === 2, "display assertion did not return");
            pids = childrenOf(ownerPid);
            expect(pids[0]).toBe(system);
            await until(() => assertionsFor(pids[1]!).includes("PreventUserIdleDisplaySleep"),
              "display assertion not ready after toggle");
            expect(assertionsFor(pids[1]!)).toContain("PreventUserIdleDisplaySleep");
          }
          if (key === "SIGTERM" || key === "SIGHUP") process.kill(ownerPid, key);
          else {
            wrapper.stdin.write(key);
            await wrapper.stdin.flush();
          }
          wrapper.stdin.end();
          expect(await wrapper.exited).toBe(code);
          expect(pids.every(pid => !exists(pid))).toBe(true);
          const text = await Bun.file(output).text();
          expect(text).toContain("DOPPIO_TTY_RESTORED");
          expect(text).toContain("00:01:00");
          if (code === 0) {
            expect(text).toContain("00:00:59");
            expect(text).toContain("toggle display sleep prevention");
            expect(text).toContain("display sleep allowed");
          }
          expect(await Bun.file(errors).text()).toBe("");
        } finally {
          wrapper.stdin.end();
          if (owner !== undefined && exists(owner)) process.kill(owner, "SIGTERM");
          if (wrapper.exitCode === null) wrapper.kill("SIGTERM");
          await wrapper.exited;
          for (const pid of pids) if (exists(pid)) process.kill(pid, "SIGKILL");
        }
      }, 10000);
    }
  }

  test("owner SIGKILL releases both assertions through caffeinate -w", async () => {
    const wrapper = Bun.spawn([...variants.at(-1)![1], "1m"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    let pids: number[] = [];
    try {
      await until(() => childrenOf(wrapper.pid).length === 2, "missing owned assertions");
      pids = childrenOf(wrapper.pid);
      await Bun.sleep(100);
      for (const pid of pids) expect(assertionsFor(pid)).toContain("PreventUserIdle");
      wrapper.kill("SIGKILL");
      await wrapper.exited;
      await until(() => pids.every(pid => !exists(pid)), "owner-bound children survived owner death");
      for (const pid of pids) expect(assertionsFor(pid)).toBe("");
    } finally {
      if (wrapper.exitCode === null) wrapper.kill("SIGTERM");
      await wrapper.exited;
      for (const pid of pids) if (exists(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test("real caffeinate completes the shared one-minute deadline", async () => {
    const wrapper = Bun.spawn([...variants.at(-1)![1], "1m"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 65000,
    });
    let children: number[] = [];
    const started = performance.now();
    try {
      await until(() => childrenOf(wrapper.pid).length === 2, "missing timed assertions");
      children = childrenOf(wrapper.pid);
      expect(await wrapper.exited).toBe(0);
      expect(performance.now() - started).toBeGreaterThanOrEqual(59000);
      expect(children.every(pid => !exists(pid))).toBe(true);
      expect(await new Response(wrapper.stderr).text()).toBe("");
    } finally {
      if (wrapper.exitCode === null) wrapper.kill("SIGTERM");
      await wrapper.exited;
      for (const pid of children) if (exists(pid)) process.kill(pid, "SIGKILL");
    }
  }, 70000);
}
