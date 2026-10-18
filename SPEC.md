# Doppio specification

## Purpose and status

Doppio is a standalone macOS terminal utility that makes keeping a Mac awake
convenient and visible. It uses the built-in `/usr/bin/caffeinate` for power
assertions, but its interface need not mirror caffeinate's flags or behavior.
Use `doppio` or its short name, `dop`.

This is a living design, updated through collaboration as the utility evolves.
Revisit requirements when implementation or usage reveals a better approach;
record intentional changes here rather than treating an earlier spec as fixed.
Confirmed direction, proposals, and open questions are distinguished below.

The baseline from [#4](https://github.com/angelocordon/doppio/pull/4) provided
duration parsing and signal forwarding. The lean foreground iteration now adds
a countdown, system/display sleep prevention by default, and single-key controls.
The README documents delivered behavior. Detached operation and cross-process
session control below are future direction, not implemented features.

## Delivered foreground iteration

- Run independent foreground sessions with one monotonic deadline and two owned
  caffeinate children: continuous `-i` and switchable `-d`, each bounded with
  `-t` and tied to its owner's exit with `-w`.
- Show `HH:MM:SS` remaining (hours may exceed two digits), the display policy,
  and discoverable controls: s toggles display prevention, q stops normally,
  ? shows help, and Ctrl-C interrupts.
- Reap children and restore terminal input after completion, q, interruption,
  and handled termination. Ctrl-D stops; Ctrl-Z/SIGTSTP ends rather than
  suspending an assertion-holding session.
- Fall back to plain foreground start/end messages without shortcuts if either
  stream is not a TTY or `TERM=dumb`. Never silently detach.
- Reject legacy `-d` and future `--detach` with an explanation that both
  assertions are the default and detachment is not implemented.
- Keep invocation independence. No workers, sockets, registries, locks, saved
  state, status/stop commands, attach/watch, restart, or timer extension.

The approved foreground scope deliberately leaves the broader session-management
design for a later iteration. Forced-system-sleep accounting remains unguaranteed;
no native clock glue or wall-clock substitution is introduced.

## Confirmed direction

- Keep TypeScript and Bun. Compile a standalone macOS executable so users do not
  need Node, Bun, or another separately installed JavaScript runtime.
- Make the default foreground experience interactive, inspired by Vite: show
  session information, a live countdown, and discoverable single-key shortcuts.
  The session occupies the terminal until completion or interruption.
- Prevent both idle system sleep and idle display sleep by default.
- Provide an interactive shortcut to allow display sleep while continuing to
  prevent idle system sleep, and to switch back.
- Use `-d` / `--detach` to start in the background and return the shell prompt.
  This is future behavior, intentionally replacing the baseline's `-d` display
  flag. The foreground iteration rejects the flag until detachment exists.
- Provide `dop status` to report remaining time and mode without holding the
  terminal, and `dop stop` to end an active session. These are future commands.

## Command interface

The delivered CLI is `dop DURATION`, `dop -h | --help`, and `dop -v | --version`. The complete future
session-management interface (not implemented in this iteration) is:

```text
dop DURATION
dop DURATION -d
dop DURATION --detach
dop status
dop stop
dop -h | --help
dop -v | --version
```

Both command names expose the same behavior. Help must explain the new defaults,
detach flag, and available commands. Invalid input produces a clear diagnostic
without starting a session.

### Durations

Retain lowercase whole hours and/or minutes, in that order, without spaces:
`30m`, `1h`, `1h30m`, and `90m`. Each unit may appear at most once. Components
are nonnegative decimal integers and the total must be positive; `0h30m` and
`2h90m` are valid.

Reject bare numbers, signs, fractions, seconds/milliseconds, reversed or repeated
units, malformed input, and zero-length durations. Convert to whole seconds
with safe integer arithmetic and cap the total at 2,147,483,647 seconds.
`caffeinate -t` takes seconds: `1h30m` is `5400`, not `5400000`.

### Interactive foreground experience

Show the remaining time in `HH:MM:SS`, the current system/display mode, and
available shortcuts. Update in place rather than scrolling the terminal.
Compute remaining time from a deadline rather than decrementing a counter on
each tick, so rendering delays do not accumulate drift. Use a monotonic clock
for elapsed time rather than depending on the wall clock.

The display toggle changes only display sleep prevention. Allowing display sleep
lets macOS's normal idle policy take over; it does not immediately turn off the
screen. Keep the active mode and shortcut label in sync.

Ctrl-C stops a foreground session, releases its assertions, and restores normal
terminal input. Completion and error paths must also restore terminal settings.
Do not require a full TUI framework just to render a countdown and read keys.

Illustrative layout; s, q, ?, and Ctrl-C are the delivered controls:

```text
  doppio
  s  toggle display sleep | q  stop | ?  help | Ctrl-C  interrupt
  00:28:46  system awake / display awake
```

### Detached sessions and control commands

Detached operation must not require keeping the launching terminal open.
Only report a successful start once the session is established; report startup
failures explicitly. A session-scoped worker is a possible implementation,
not a requirement for a permanently installed daemon.

`status` should return promptly with the active session's remaining time and
system/display mode, or explicitly say no session is active. It describes
Doppio sessions, not assertions held by other applications.

`stop` should release the targeted Doppio session's assertions and end its
worker. Never signal unrelated processes. Session selection and behavior when
no session exists remain open below.

## Process lifecycle and boundaries

Launch `/usr/bin/caffeinate` with direct arguments, never shell interpolation
or PATH lookup. Keep system sleep prevention enabled when changing display
mode. Coordinate the deadline, displayed countdown, and assertion lifetime;
an unexpected child failure must be visible, not presented as a healthy session
or successful completion.

Foreground completion, Ctrl-C, and termination must clean up owned children.
Detached sessions require lifecycle and state handling beyond the minimal
foreground implementation; choose that design before implementing background
operation. Independent invocations remain valid for the foreground-only scope,
but are not sufficient for future `status` and `stop`.

Retain the baseline exit conventions where applicable: help and successful
completion exit 0, invalid input exits 2, launch errors exit 1, Ctrl-C exits 130,
and SIGTERM exits 143 after cleanup. The foreground iteration also returns 0
for q, 1 for unexpected assertion failure, 129 for SIGHUP, and 146 for macOS
suspension requests after cleanup. Define future control-command outcomes
alongside their unresolved semantics.

Preventing idle sleep does not bypass lid-close sleep, explicit Sleep, low
battery, screen locking, or device/organizational policy. Supported powered
clamshell operation remains macOS's responsibility. Do not promise to wake an
already sleeping display or use caffeinate's `-s`, `-u`, or `-m` flags.

## Implementation and distribution

Keep the implementation proportionate to the features. The baseline's one-file
shape is not a permanent constraint, but avoid unnecessary abstractions,
dependencies, native glue, or background services.

Bun is required to develop, test, and build, not to run the compiled executable.
Compiled output embeds its runtime and is not assumed tiny. Document measured
size and build version, and build for each supported Mac architecture.

Direct release downloads and Homebrew are desired distribution channels.
npm/pnpm distribution is also of interest, but its packaging approach and priority
are not decided. A package-manager installation channel does not require using
that package manager's runtime to execute the compiled binary.

Keep generated binaries out of source control. Do not silently modify shell
startup files or overwrite existing commands during manual installation.

## Open design questions

- Should there be one active session per user, or multiple addressable sessions?
  How should a second start behave, and which session do `status` and `stop` target?
- Should the delivered shortcut map evolve? Timer restart, adding time, and
  in-session detachment have been suggested but are not confirmed features.
- Should a CLI option allow display sleep from the start, and what is its name?
- Can users attach a visual timer to an existing detached session? If so, does
  closing that view merely stop watching, or end the session?
- Should plain foreground non-TTY behavior change when background operation
  becomes available? Single-key input requires a suitable terminal.
- What state, locking, process identity, and crash/disconnection cleanup are
  needed for reliable detached operation and control commands?
- Should countdown time include time spent in forced system sleep?
- What are the exact output and exit conventions for inactive status, inactive
  stop, and session-control failures?

## Verification direction

Keep existing parsing, direct subprocess invocation, source/compiled execution,
and real-macOS assertion checks. Default assertions now include display sleep
prevention, and `-d` is explicitly rejected. Update expectations again when
detached operation implements the flag.

Add focused coverage with each implemented feature: countdown accuracy,
interactive keys and terminal restoration, display toggling without losing
system sleep prevention, foreground cleanup, detached startup and survival
after terminal closure, accurate status, and safe stop. Resolve session-selection
and lifecycle questions before specifying their detailed acceptance criteria.

Use isolated test state and stop/reap only test-owned processes. Keep tests
proportional; do not add unrelated CI or packaging infrastructure to deliver
the terminal experience.
