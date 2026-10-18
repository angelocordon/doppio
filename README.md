# doppio

A small macOS terminal utility around the built-in `caffeinate`, written in
TypeScript with Bun. Use **`doppio`** or its symlink **`dop`**.

## Current behavior

Each invocation runs independently in the foreground. In an interactive
terminal, Doppio shows a live `HH:MM:SS` countdown and single-key controls:

```sh
dop 30m
dop 1h30m
dop 1h
```

Doppio prevents **idle system and display sleep** by default. Press **s** to
allow display sleep while keeping the system awake, then **s** again to restore
display sleep prevention. This lets macOS's idle policy take over; it does not
immediately turn off the screen or change screen locking.

Press **q** to stop normally, **Ctrl-C** to interrupt, or **?** for help.
Keep the terminal open. Completion and handled termination restore terminal
input and release the owned assertions. Ctrl-D also stops; Ctrl-Z ends the
session rather than suspending it while leaving assertions running.

With redirected input/output or `TERM=dumb`, Doppio stays in the foreground
and prints plain start/end messages, without animation or shortcuts. Signals
still stop it. There is no detached operation, status/stop command, or saved
session state. Multiple invocations remain independent.

## Current usage

```text
doppio DURATION
doppio -h | --help
doppio -v | --version
```

`-v` / `--version` prints the version, e.g. `doppio 0.1.0 (a61c636)`. The
interactive session header shows the same label.

Durations use lowercase whole hours and/or minutes, in that order, without
spaces: `30m`, `1h`, `1h30m`, or `90m`. `0h30m` and `2h90m` are also valid.
Each unit may occur once; the total must be positive. Seconds, milliseconds,
bare numbers, signs, fractions, extra arguments, and `--display` are unsupported.
The maximum is 2,147,483,647 seconds; the largest whole-minute input is
`35791394m`.

**Compatibility change:** legacy `-d` is explicitly rejected: both assertions
are now the default. `-d` / `--detach` will not mean detach until background
operation is implemented.

Doppio owns two `/usr/bin/caffeinate` children, one with `-i` for system sleep
and one with `-d` for display sleep. Both use `-w OWNER_PID -t SECONDS`.
The display toggle stops/restarts only the display child, leaving the system
child uninterrupted. `-w` ties assertion lifetime to the owning Doppio process;
`-t` provides an additional finite bound. No command is looked up through PATH.

One monotonic deadline drives expiry and the countdown; delayed renders do not
accumulate drift or reset the timer. Each child receives the remaining duration
rounded up to whole **seconds**, not milliseconds. Unexpected assertion-child
exit ends the session with a diagnostic instead of showing a healthy countdown.

Help, completion, and q exit 0; invalid arguments exit 2; operational failures
exit 1. Ctrl-C exits 130, SIGTERM 143, SIGHUP 129, and suspension requests 146
on macOS, after owned-child cleanup. Terminal state cannot be restored after
SIGKILL or a crash, but owner-bound caffeinate assertions release on owner exit.

## Future direction (not implemented yet)

The foreground countdown is the first lean iteration of the Vite-inspired
experience. Background operation and cross-process control remain future work.
The planned command interface is:

| Command | Planned behavior |
| --- | --- |
| `dop 30m -d` | Start detached and return the shell prompt |
| `dop 30m --detach` | Same as `-d` |
| `dop status` | Print remaining time and mode, then exit |
| `dop stop` | End the active session |

**Future flag change:** `-d` will mean **detach**, not display sleep prevention.
It is currently rejected, not interpreted as detach. Doppio's
interface does not need to match caffeinate's flags one-for-one.

The current view uses these controls:

```text
  doppio 0.1.0 (a61c636)
  s  toggle display sleep | q  stop | ?  help | Ctrl-C  interrupt
  00:28:46  system awake / display awake
```

Future session selection and attaching to detached sessions remain open design
questions. Current invocations are independent. Restarting or extending timers and
detaching through a shortcut are ideas, not committed features.

[SPEC.md](SPEC.md) records confirmed direction and unresolved decisions. It is
a living design: implementation and usage can inform deliberate changes through
collaboration, rather than being constrained by an earlier draft.

Direct binary downloads and Homebrew are desired installation channels;
npm/pnpm distribution is also under consideration. These are not available yet.
The compiled executable will continue to run without a separately installed
JavaScript runtime; the current build and manual-install steps follow.

## Build

Development requires macOS and [Bun](https://bun.com/docs/installation).
The implementation is verified with Bun **1.3.0**; no package install is needed.
End users of the compiled executable do **not** need Bun or Node installed.
The executable still needs macOS's `/usr/bin/caffeinate`, which is selected
explicitly rather than searching PATH.

```sh
git clone https://github.com/angelocordon/doppio.git
cd doppio
bun run build
./dist/doppio --help
```

`package.json` records the Bun version and provides build/test scripts; it
declares no dependencies, so `bun install` is unnecessary.

This builds for the current machine's architecture. Bun embeds its runtime:
the macOS arm64 build with Bun 1.3.0 is approximately **60.4 MB**, not a tiny
native binary. Build again after changing source files; documentation-only
changes need no rebuild. Generated binaries are ignored, not checked in.

The version comes from `package.json`'s `version` field. `bun run build`
also embeds the current git short commit, so a compiled binary reports e.g.
`doppio 0.1.0 (a61c636)`; running from source reports `doppio 0.1.0`. Bump
`version` in `package.json` when cutting a release.
No signed release or installer is provided.

For development without compiling:

```sh
bun run ./doppio.ts 30m
```

## Manual installation

After building, install both names into a user-owned directory:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 ./dist/doppio "$HOME/.local/bin/doppio"
ln -s doppio "$HOME/.local/bin/dop"
```

The symlink command deliberately refuses to overwrite an existing `dop`;
inspect any conflict before replacing it. Nothing edits shell startup files.
If needed, enable the directory for this terminal only:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

To update, rebuild and repeat `install`; keep the existing symlink.
To uninstall, remove the installed `dop` symlink and `doppio` executable.
There are no state files, locks, services, or background daemons to remove.

## Checks

```sh
bun run test
DOPPIO_BINARY=./dist/doppio bun run test
DOPPIO_BINARY=./dist/doppio DOPPIO_REAL_TESTS=1 bun run test
```

The first command covers parsing, deadline/formatting, display toggles, owned
child failures/cleanup, view restoration, and the source CLI. The second also
exercises the compiled CLI and `dop` symlink. The final command is macOS-only:
it checks actual power assertions, display toggles without replacing the system
child, terminal q/Ctrl-C/Ctrl-Z and restoration via macOS `script`, plain output
and wrapper-only SIGTERM/SIGHUP, and assertion release after owner SIGKILL.
It also waits for **one real one-minute completion**. Real checks stop/reap only
test-owned processes. Test-only temporary files are removed afterward.

## Boundaries

Idle sleep prevention does not bypass lid-close sleep, explicit Sleep, low
battery, screen locking, or organizational/device policies. It does not promise
to wake an already sleeping display. Powered clamshell operation remains
macOS's responsibility.

Doppio does not use `caffeinate -s`, `-u`, or `-m`. There is no detached
mode, command wrapping, session registry, or cross-process coordination.
Forced sleep/resume time accounting is not guaranteed; the timer is not a
wall-clock alarm. Doppio does not promise to survive a terminal disconnect.
Use `pmset -g assertions` to inspect system-wide power assertions.
