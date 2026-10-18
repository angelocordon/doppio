const usage = `Usage: doppio [-d] DURATION
       doppio -h | --help
DURATION: positive whole hours/minutes, e.g. 2h, 45m, 1h30m
Prevents idle system sleep; -d also prevents idle display sleep.
Keep this terminal open. Press Ctrl-C to stop early.
dop is another name for the same command.`;

export function commandFor(args: string[]): string[] | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return null;
  const display = args[0] === "-d";
  const duration = args[display ? 1 : 0];
  const match = args.length === (display ? 2 : 1) && duration &&
    /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(duration);
  const seconds = match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 : 0;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 2147483647) {
    throw new Error(`invalid duration or arguments\n${usage}`);
  }
  return ["/usr/bin/caffeinate", "-i", ...(display ? ["-d"] : []), "-t", String(seconds)];
}

export async function run(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  let interrupted: number | undefined;
  const interrupt = () => { interrupted = 130; child.kill("SIGINT"); };
  const terminate = () => { interrupted = 143; child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const code = await child.exited;
    if (code !== 0 && interrupted === undefined) {
      console.error(`doppio: caffeinate exited with status ${code}`);
    }
    return interrupted ?? code;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  let command: string[] | null;
  try {
    command = commandFor(Bun.argv.slice(2));
  } catch (error) {
    console.error(`doppio: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (command === null) {
    console.log(usage);
    process.exit(0);
  }
  try {
    process.exit(await run(command));
  } catch (error) {
    console.error(`doppio: could not run caffeinate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
