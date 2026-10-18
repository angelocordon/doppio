import { runSession } from "./session";
import { terminalView } from "./terminal";
import { versionLabel } from "./version";

const usage = `Usage: doppio DURATION
       doppio -h | --help
       doppio -v | --version
DURATION: positive whole hours/minutes, e.g. 2h, 45m, 1h30m
Prevents idle system and display sleep by default.
In an interactive terminal: s toggles display sleep prevention; q stops.
Keep this terminal open. Press Ctrl-C to stop early.
No detached operation or status/stop commands are implemented yet.
dop is another name for the same command.`;

export function versionRequested(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
}

export function durationFor(args: string[]): number | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return null;
  if (args.includes("-d") || args.includes("--detach")) {
    throw new Error(`-d/--detach is not supported: system and display sleep prevention are now enabled by default; detachment is not implemented\n${usage}`);
  }
  const match = args.length === 1 && /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(args[0]!);
  const seconds = match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 : 0;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 2147483647) {
    throw new Error(`invalid duration or arguments\n${usage}`);
  }
  return seconds;
}

if (import.meta.main && versionRequested(Bun.argv.slice(2))) {
  console.log(versionLabel);
} else if (import.meta.main) {
  let seconds: number | null;
  try {
    seconds = durationFor(Bun.argv.slice(2));
  } catch (error) {
    console.error(`doppio: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (seconds === null) {
    console.log(usage);
  } else {
    try {
      const code = await runSession(seconds, { view: terminalView() });
      console.log("doppio: session ended");
      process.exitCode = code;
    } catch (error) {
      console.error(`doppio: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
