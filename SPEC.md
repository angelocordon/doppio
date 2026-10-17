# Doppio specification

This is the source of truth for the initial utility's scope and behavior.
The README describes installation and everyday use.

## Goal

Provide a small, dependency-light macOS terminal wrapper around the built-in
`caffeinate`, called `doppio` with `dop` as the short command. The primary use
case is temporarily preventing idle sleep while working, including supported
powered-clamshell setups with an external display.

## CLI contract

- `dop DURATION` and `doppio DURATION` prevent idle system sleep, allowing the
  display to sleep. Invoke `caffeinate -i`.
- Accept positive whole hours and/or minutes, in that order: `1h`, `30m`, `90m`,
  `1h30m`. Reject missing units, fractions, negative/zero durations, unknown
  arguments, and trailing input. Bound the timeout to 2,147,483,647 seconds.
- `-d DURATION` and `--display DURATION` additionally prevent idle display sleep,
  matching `caffeinate -d`. Neither form declares user activity or disables locks.
- Run in the foreground, showing a live `HH:MM:SS` countdown. Update one line on
  a terminal, or emit one line per second when redirected.
- `dop status` from another terminal shows remaining time and the current mode,
  or explicitly says no session is active. Both command names share state.
- `-h` and `--help` describe the CLI.
- Return 0 for completion/help/status, 1 for errors, 130 for Ctrl-C, 143 for
  SIGTERM, and 129 for SIGHUP.

## Lifecycle and state

- Allow only one active session per user. Reject a concurrent start without
  replacing the existing session's state or signaling its processes.
- Use private per-user state in `~/Library/Application Support/doppio`, with a
  `0700` directory and private regular state/lock files. Reject unsafe directories,
  lock files, and active state (including symlinks). Publish complete state
  atomically; stale state may be safely unlinked without following its contents.
- Use an OS-held lock, not a saved PID, to determine whether a session is active.
  Ignore stale JSON without a held lock; replace it on the next successful start.
  Keep the lock file in place so different invocations lock the same inode.
- Use a monotonic deadline for the countdown and status, independent of wall
  clock changes. State is local to this machine and this user's HOME.
- On expiration, Ctrl-C, SIGTERM, SIGHUP, or a startup/runtime error, stop and
  reap only the wrapper's own child and remove the session record.
- Pass both `-t SECONDS` and `-w WRAPPER_PID` to caffeinate so assertions are
  bounded and released if the wrapper is force-killed. Never kill a PID read
  from persisted state.
- Surface invalid active state, state-access errors, and caffeinate failures.
  Do not report a successful completed session when caffeinate fails early.

## Non-goals and boundaries

No background/detached mode, command wrapping, daemon, shell-startup changes,
automatic PATH installation, third-party runtime modules, CI infrastructure,
or packaging ecosystem is included.

Preventing idle sleep does not override forced lid-close sleep, explicit Sleep,
low-battery behavior, screen locking, or organizational policies. Doppio does not
create an unsupported clamshell configuration or promise to wake a sleeping
display. Do not use caffeinate's `-s`, `-u`, or `-m` flags.

## Acceptance criteria

- Both command names launch the same behavior; README commands install both
  explicitly without modifying shell configuration.
- Focused tests verify accepted/rejected durations and their exact seconds,
  a decreasing countdown, active/inactive status, both display flag spellings,
  exact caffeinate argument lists, and concurrent-start rejection.
- Tests verify expiration, Ctrl-C, termination, stale state, unsafe state,
  malformed active JSON, exec failure, and unexpected child exit.
- Short macOS integration checks run real caffeinate in both modes and verify
  cleanup, including abrupt wrapper death, without leaving assertions running.
- Tests isolate their HOME and state; no tests signal unrelated processes.
