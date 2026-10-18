# doppio

A small macOS terminal utility around the built-in `caffeinate`, written in
TypeScript with Bun. Use **`doppio`** or its symlink **`dop`**.

```sh
dop 30m
dop 1h30m
dop -d 1h
```

By default, doppio prevents **idle system sleep** but lets the display sleep.
`-d` adds idle display sleep prevention without dropping system sleep prevention.
Keep the terminal open; **Ctrl-C** stops early and releases both assertions.
There is no countdown or status command. Multiple invocations are independent.

## Usage

```text
doppio [-d] DURATION
doppio -h | --help
```

Durations use lowercase whole hours and/or minutes, in that order, without
spaces: `30m`, `1h`, `1h30m`, or `90m`. `0h30m` and `2h90m` are also valid.
Each unit may occur once; the total must be positive. Seconds, milliseconds,
bare numbers, signs, fractions, extra arguments, and `--display` are unsupported.
The maximum is 2,147,483,647 seconds; the largest whole-minute input is
`35791394m`.

| Invocation | Command run |
| --- | --- |
| `dop 30m` | `/usr/bin/caffeinate -i -t 1800` |
| `dop -d 1h30m` | `/usr/bin/caffeinate -i -d -t 5400` |

`caffeinate -t` takes **seconds**, not milliseconds. Doppio delegates all timing
to it and waits in the foreground. Standard streams are inherited. Help and
normal completion exit 0; invalid arguments exit 2; launch failures exit 1.
Other child exit codes propagate, with a diagnostic for unexpected failure.
Ctrl-C exits 130; SIGTERM sent only to doppio is forwarded to its child, which
is reaped before doppio exits 143.

## Build

Development requires macOS and [Bun](https://bun.com/docs/installation).
The implementation is verified with Bun **1.3.0**; no package install is needed.
End users of the compiled executable do **not** need Bun or Node installed.
The executable still needs macOS's `/usr/bin/caffeinate`, which is selected
explicitly rather than searching PATH.

```sh
git clone https://github.com/angelocordon/doppio.git
cd doppio
mkdir -p dist
bun build --compile ./doppio.ts --outfile ./dist/doppio
./dist/doppio --help
```

This builds for the current machine's architecture. Bun embeds its runtime:
the macOS arm64 build with Bun 1.3.0 is approximately **60.4 MB**, not a tiny
native binary. Build again after changing `doppio.ts`; documentation-only
changes need no rebuild. Generated binaries are ignored, not checked in.
No signed release or installer is provided.

For development without compiling:

```sh
bun run ./doppio.ts -d 30m
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
bun test ./doppio.test.ts
DOPPIO_BINARY=./dist/doppio bun test ./doppio.test.ts
DOPPIO_BINARY=./dist/doppio DOPPIO_REAL_TESTS=1 bun test ./doppio.test.ts
```

The first command covers duration/argv generation, subprocess exits and launch
errors, and the source CLI. The second also exercises the compiled CLI and
`dop` symlink. The final command is macOS-only: it briefly checks actual power
assertions, terminal Ctrl-C via macOS `script`, and wrapper-only SIGTERM in both
modes for source and compiled builds. It also waits for **one real one-minute
completion**. Real checks stop/reap their own children; they do not signal
unrelated processes. Test-only temporary files are removed afterward.

## Boundaries

Idle sleep prevention does not bypass lid-close sleep, explicit Sleep, low
battery, screen locking, or organizational/device policies. It does not promise
to wake an already sleeping display. Powered clamshell operation remains
macOS's responsibility.

Doppio does not use `caffeinate -s`, `-u`, `-m`, or `-w`. There is no detached
mode, command wrapping, session registry, or cross-process coordination.
SIGKILL, crashes, and terminal disconnection have no custom cleanup guarantee;
`caffeinate -t` still bounds any surviving assertion's lifetime. Use
`pmset -g assertions` to inspect system-wide power assertions.
