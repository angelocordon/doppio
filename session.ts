import { constants } from "node:os";
import type { Subprocess } from "bun";

export type Assertion = "system" | "display";
export type Action = "toggle" | "stop" | "interrupt" | "suspend";
export interface Snapshot {
  remaining: number;
  displayAwake: boolean;
}
export interface View {
  open(onAction: (action: Action) => void, onError: (error: Error) => void): void;
  render(snapshot: Snapshot): void;
  close(): void | Promise<void>;
}
type Child = Subprocess<"ignore", "ignore", "inherit">;
interface SessionOptions {
  view: View;
  now?: () => number;
  spawnAssertion?: (kind: Assertion, seconds: number) => Child;
}

export function remainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function formatRemaining(seconds: number): string {
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ].map(value => String(value).padStart(2, "0")).join(":");
}

export function assertionCommand(kind: Assertion, seconds: number): string[] {
  return [
    "/usr/bin/caffeinate", kind === "system" ? "-i" : "-d",
    "-w", String(process.pid), "-t", String(seconds),
  ];
}

async function stopChild(child: Child): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (child.exitCode !== null || child.signalCode !== null) {
      await child.exited;
      return;
    }
    child.kill("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function runSession(seconds: number, options: SessionOptions): Promise<number> {
  const now = options.now ?? (() => performance.now());
  const spawn = options.spawnAssertion ?? ((kind, remaining) =>
    Bun.spawn(assertionCommand(kind, remaining), {
      stdin: "ignore", stdout: "ignore", stderr: "inherit",
    }));
  const deadline = now() + seconds * 1000;
  const children = new Map<Assertion, Child>();
  const view = options.view;
  let stopping = false;
  let displayAwake = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let actions = Promise.resolve();
  let actionError: Error | undefined;
  let finish!: (outcome: { code: number; error?: Error }) => void;
  const done = new Promise<{ code: number; error?: Error }>(resolve => {
    finish = outcome => {
      if (!stopping) {
        stopping = true;
        resolve(outcome);
      }
    };
  });
  const fail = (error: unknown) => finish({
    code: 1, error: error instanceof Error ? error : new Error(String(error)),
  });
  const render = () => view.render({
    remaining: remainingSeconds(deadline, now()), displayAwake,
  });
  const startChild = (kind: Assertion) => {
    const remaining = remainingSeconds(deadline, now());
    if (stopping || remaining === 0) return;
    const child = spawn(kind, remaining);
    children.set(kind, child);
    void child.exited.then(code => {
      if (children.get(kind) !== child || stopping) return;
      if (now() >= deadline) finish({ code: 0 });
      else fail(new Error(`${kind} caffeinate exited unexpectedly (status ${code})`));
    });
  };
  const onAction = (action: Action) => {
    if (action !== "toggle") {
      const code = action === "interrupt" ? 130 :
        action === "suspend" ? 128 + constants.signals.SIGTSTP : 0;
      finish({ code });
      return;
    }
    actions = actions.then(async () => {
      if (stopping || now() >= deadline) return;
      const display = children.get("display");
      if (display) {
        children.delete("display");
        try {
          await stopChild(display);
        } catch (error) {
          children.set("display", display);
          throw error;
        }
        displayAwake = false;
      } else {
        startChild("display");
        displayAwake = true;
      }
      if (!stopping) render();
    }).catch(error => {
      actionError = error instanceof Error ? error : new Error(String(error));
      fail(actionError);
    });
  };
  const signals = {
    SIGINT: () => finish({ code: 130 }),
    SIGTERM: () => finish({ code: 143 }),
    SIGHUP: () => finish({ code: 129 }),
    SIGTSTP: () => onAction("suspend"),
  };
  for (const [signal, handler] of Object.entries(signals)) process.on(signal, handler);
  let outcome: { code: number; error?: Error } = { code: 0 };
  const cleanupErrors: unknown[] = [];
  try {
    startChild("system");
    startChild("display");
    view.open(onAction, fail);
    render();
    timer = setInterval(() => {
      try {
        if (now() >= deadline) finish({ code: 0 });
        else if (!stopping) render();
      } catch (error) {
        fail(error);
      }
    }, 100);
    outcome = await done;
  } catch (error) {
    outcome = { code: 1, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    stopping = true;
    clearInterval(timer);
    try { await view.close(); } catch (error) { cleanupErrors.push(error); }
    await actions;
    outcome.error ??= actionError;
    const results = await Promise.allSettled([...children.values()].map(stopChild));
    for (const result of results) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    for (const [signal, handler] of Object.entries(signals)) process.removeListener(signal, handler);
  }
  if (cleanupErrors.length) {
    throw new Error([
      outcome.error?.message,
      ...cleanupErrors.map(error => `cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
    ].filter(Boolean).join("; "));
  }
  if (outcome.error) throw outcome.error;
  return outcome.code;
}
