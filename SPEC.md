# Doppio specification

## Goal and scope

Make macOS's built-in `caffeinate` convenient to invoke with hours and minutes.
Implement a thin foreground utility named `doppio` in one readable TypeScript
file using Bun's public built-in subprocess APIs. Compile a standalone
executable with `bun build --compile`; the end user needs no separately
installed JavaScript runtime. `dop` is a symlink to the same executable.

This specification replaces the earlier countdown, status, and shared-state
requirements. It is a convenience wrapper, not a session-management application.

## CLI contract

```text
doppio [-d] DURATION
doppio -h | --help
```

`dop` has exactly the same behavior, not a second implementation. Help briefly
describes the syntax, units, display option, and Ctrl-C. No arguments, unknown
options, or extra arguments produce a
clear error and a nonzero exit without starting `caffeinate`.

Durations use lowercase whole hours and/or minutes, in that order, without
spaces: `30m`, `1h`, `1h30m`, and `90m`. Each unit may appear at most once.
Components are nonnegative decimal integers and the total must be positive;
`0h30m` and `2h90m` are valid. Reject bare numbers, signs, fractions, `s`/`ms`,
reversed/repeated units, malformed strings, and zero-length durations.

Convert once to whole seconds: hours * 3600 + minutes * 60. Reject unsafe
integer arithmetic or a total above 2,147,483,647 seconds with a simple bounds
check. Do not add a duration-parsing dependency.

**Units correction:** `caffeinate -t` accepts seconds, not milliseconds.
`1h30m` is `5400` seconds, not `5400000`.

### Assertion flags

Prevent idle system sleep by default. `-d` additionally prevents idle display
sleep; it does not replace `-i`:

| Invocation | Delegated command |
| --- | --- |
| `dop 30m` | `/usr/bin/caffeinate -i -t 1800` |
| `dop -d 1h30m` | `/usr/bin/caffeinate -i -d -t 5400` |

Do not expand the CLI with additional modes or a `--display` option.

## Delegation and boundaries

Launch `/usr/bin/caffeinate` with a direct argument array, not shell
interpolation or PATH lookup. Inherit standard streams, wait for the child,
and let it own timing and assertions. Keep the terminal session open.
Forward SIGINT and SIGTERM to this invocation's child and reap it before
exiting. Do not introduce a custom lifecycle subsystem.

Help and normal completion exit 0. Invalid input produces a clear diagnostic
and exits 2 without launching the child. Launch errors are visible and exit 1;
unexpected child failures are reported and preserve the child's exit code.
Ctrl-C exits 130 and wrapper-only SIGTERM exits 143 after child cleanup.
There is no custom SIGHUP, crash, or SIGKILL cleanup guarantee; the delegated
timeout bounds any surviving assertion. Do not add wrapper-PID `-w` bookkeeping.

Multiple invocations are independent and allowed. No countdown, status command,
session registry, PID records, OS-held locks, atomic private state, cross-process
clocks, daemon, UI, background service, detached mode, or command-wrapping mode.
Do not recreate the old lifecycle guarantees through helper subsystems.

Preventing idle sleep does not bypass lid-close sleep, explicit Sleep, low
battery, locking, or device/organizational policy. Supported powered-clamshell
use remains macOS's responsibility. Do not promise to wake an already sleeping
display or use `caffeinate`'s `-s`, `-u`, or `-m` flags.

## Implementation and distribution

Use Bun's supported `spawn`, subprocess `exited`/`kill`, and process signal
listeners. Keep duration parsing dependency-free and expose small internal
functions for focused tests without test-only CLI flags or environment bypasses.
Do not add native code, FFI, third-party runtime packages, own duration timers,
or a framework merely to restore the old guarantees.

Bun is required to develop, test, and build, not to run the compiled executable.
Its standalone output embeds the runtime and is not assumed tiny; document the
measured size and build version. Build for the intended macOS architecture.
Provide explicit manual installation of the executable and `dop` symlink.
Do not modify shell startup files or automatically overwrite an existing alias.
Do not check in generated binaries/toolchains or add unrelated packaging
infrastructure.

## Focused acceptance checks

- Parser examples produce exact seconds: `30m` -> `1800`, `1h` -> `3600`,
  `1h30m` and `90m` -> `5400`; zero components are accepted only for a positive
  total. Reject `0m`, `1`, `1s`, `1ms`, `1.5h`, `-1m`, `30m1h`, `1h1h`,
  trailing text/arguments, and values beyond the arithmetic/timeout bounds.
- Verify both command names, small help, invalid arguments without spawning,
  and the exact absolute executable/arguments for both assertion modes.
- Exercise the real supported subprocess boundary for successful/failed child
  exits and visible launch errors without replacing production's executable
  selection or adding a public testing bypass.
- Check both source and actual compiled CLI behavior. On macOS, verify a real
  foreground run and assertions in both modes, a one-minute normal completion,
  terminal Ctrl-C without leftover work, and separately wrapper-PID-only
  SIGTERM cleanup. Use existing macOS `script` for terminal checks rather than
  building a PTY framework. Stop/reap only processes created by the check.

Keep checks proportional to a thin wrapper. No full session lifecycle suite,
private-state test harness, or unrelated packaging/CI infrastructure is required.
