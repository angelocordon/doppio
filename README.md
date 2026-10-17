# doppio

A small macOS terminal wrapper around the built-in `caffeinate`, with friendly
durations, a live foreground countdown, and status from another terminal.
Use either **`doppio`** or **`dop`**.

```sh
dop 1h
dop 30m
dop 90m
dop 1h30m
dop --display 30m
```

By default, doppio prevents **idle system sleep** but lets the display sleep.
`-d` / `--display` also prevents idle display sleep, matching `caffeinate -d`.
Press **Ctrl-C** to stop early and release the assertions.

## Requirements

macOS with `/usr/bin/caffeinate` and `/usr/bin/perl` (including its standard
modules). Both are supplied by current macOS installations; no Homebrew packages,
third-party Perl modules, shell plugins, or background service are needed.

## Install

Clone into your preferred directory:

```sh
git clone https://github.com/angelocordon/doppio.git ~/Development/doppio
cd ~/Development/doppio
./dop 30m
# Or: ./doppio 30m
```

To install both command names into a user-owned directory:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 doppio "$HOME/.local/bin/doppio"
ln -s doppio "$HOME/.local/bin/dop"
```

Run these commands from the cloned repository. The link command deliberately
does not overwrite an existing `dop`; check any conflict before replacing it.
If `~/.local/bin` is not already on your PATH, you can use the full paths or
enable it for the current terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Nothing modifies shell startup files or installs itself automatically. To
update, pull the repository and repeat the `install` command; the link can stay.
To uninstall, remove the two installed command paths. Do not remove state files
while a session is running.

## Usage

```text
dop [-d|--display] DURATION
dop status
dop --help
```

| Command | Effect |
| --- | --- |
| `dop 1h` | Prevent idle system sleep for one hour |
| `dop 90m` | Same, for ninety minutes |
| `dop 1h30m` | Same duration, with hours and minutes |
| `dop -d 30m` | Also prevent idle display sleep |
| `dop --display 30m` | Long form of `-d` |
| `dop status` | Report the current session's remaining time and mode |

Durations are positive whole hours and/or minutes, in that order, with no spaces.
`0h30m` and `2h90m` are valid. Bare numbers, seconds, negative values, fractions,
and zero-length durations are rejected. The maximum is 2,147,483,647 seconds
(the largest accepted whole-minute duration is `35791394m`).

The countdown is `HH:MM:SS`. In a terminal it updates on one line; when redirected,
it prints a line each second. There is no detached mode and no command-wrapping
mode. Keep the terminal session open. Normal completion returns exit code 0,
errors return 1, Ctrl-C returns 130, SIGTERM returns 143, and SIGHUP returns 129.

### Status and concurrent sessions

While `dop 1h` is running in one terminal, use another:

```sh
dop status
# Doppio: 00:58:42 remaining (system; display may sleep).
```

Only one doppio session per user is allowed. A second start fails explicitly
rather than replacing or stopping the first session. Both command names share
the same state under `~/Library/Application Support/doppio`, in a private `0700`
directory. A kernel-held file lock identifies an active wrapper; the small JSON
file records the monotonic countdown deadline and display mode. No PID from
saved state is ever used to kill a process.

Normal completion, Ctrl-C, SIGTERM, and SIGHUP stop and reap the wrapper's own
`caffeinate` child and remove session state. The empty `session.lock` file stays
in place to keep locking safe across invocations. If the wrapper crashes or is
force-killed, `caffeinate -w` releases assertions when its parent exits; `-t`
also bounds their lifetime. Leftover JSON is ignored without a held lock and
replaced on the next start. Invalid active state and unsafe state permissions
produce explicit errors rather than misleading status.

Status only describes doppio, not assertions made by other apps. Use
`pmset -g assertions` to inspect the system's assertions.

### Boundaries

Doppio runs `caffeinate -i -t SECONDS -w WRAPPER_PID`; display mode adds `-d`.
It does **not** use `-s` (AC-only system-sleep prevention), `-u` (declare user
activity), or `-m` (disk-sleep prevention).

This prevents **idle sleep**, not forced sleep from closing the lid, choosing
Sleep, low battery, or organizational/device-management policies. It does not
disable the screen saver, automatic locking, or security policy, and it does not
promise to wake an already sleeping display. For powered clamshell use with an
external display, macOS must already support that clamshell configuration;
doppio does not bypass lid-close behavior.

## Development

Run the focused tests from the repository root:

```sh
/usr/bin/prove -v t/doppio.t
```

The tests use isolated temporary HOME directories and a fake caffeinate for
parsing, countdown, status, concurrency, stale state, errors, and signal cleanup.
On macOS, short real-caffeinate smoke tests cover both assertion modes and clean
up their children. No minute-long assertions are left running.
