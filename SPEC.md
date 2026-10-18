# Doppio specification

## Goal and scope

Make macOS's built-in `caffeinate` convenient to invoke with hours and minutes.
A small zsh function named `doppio`, with `dop` as an alias, is a legitimate
simplest solution. A standalone TypeScript binary is an optional experiment,
not a reason to build a session-management application.

This specification supersedes the earlier countdown, status, and shared-state
requirements. The old implementation in closed, unmerged PR #1 is paused, not
the product direction. Runtime selection and implementation approval are pending.
The README still describes the earlier scope and must be reconciled after the
implementation direction is chosen.

## CLI contract

```text
doppio [-d] DURATION
doppio -h | --help
```

`dop` has exactly the same behavior through a shell alias or symlink, not a
second implementation. Help briefly describes the syntax, units, display
option, and Ctrl-C. No arguments, unknown options, or extra arguments produce a
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

### Assertion flags: provisional comparison baseline

The bounded prototypes currently preserve idle system sleep prevention by
default and add display prevention with `-d`:

| Invocation | Delegated command |
| --- | --- |
| `dop 30m` | `/usr/bin/caffeinate -i -t 1800` |
| `dop -d 1h30m` | `/usr/bin/caffeinate -i -d -t 5400` |

This is inherited behavior, **not a newly confirmed user decision**. The user's
`caffeinate -dt` illustration could instead mean display-only assertions for
`-d` (`caffeinate -d -t 5400`, without `-i`). Resolve this specific distinction
before treating either flag mapping as final. Do not expand the minimal CLI
with additional modes or a `--display` option.

## Delegation and boundaries

Run `caffeinate` in the foreground and let it own timing and assertions. Keep
the terminal session open; Ctrl-C stops the invoked work without orphaning its
`caffeinate`. Completion/help succeed; invalid input, launch errors, and
unexpected child failures are visible and nonzero. Prefer direct process
replacement or simple supported process APIs, not a custom exit-code/signal
framework. Wrapper-PID `-w` bookkeeping is not a required architecture.

Multiple invocations are independent and allowed. No countdown, status command,
session registry, PID records, OS-held locks, atomic private state, cross-process
clocks, daemon, UI, background service, detached mode, or command-wrapping mode.
Do not recreate the old lifecycle guarantees through helper subsystems.

Preventing idle sleep does not bypass lid-close sleep, explicit Sleep, low
battery, locking, or device/organizational policy. Supported powered-clamshell
use remains macOS's responsibility. Do not promise to wake an already sleeping
display or use `caffeinate`'s `-s`, `-u`, or `-m` flags.

## Implementation experiment and simplicity guardrails

Prefer one easy-to-read, easy-to-modify TypeScript file if pursuing a binary.
Perry and Bun are bounded alternatives being compared; neither is selected,
and no implementation merge is authorized by this specification.

Both can avoid a separately installed runtime for the end user. Perry's
native compilation also aims to avoid an embedded JavaScript engine; Bun's
standalone executable embeds its runtime and must not be assumed tiny.
Compiler/runtime installation is a build-time requirement, not an end-user
requirement. Compare actual support, clarity, and artifact size rather than
promising a particular binary size.

Use only straightforward supported APIs. If Perry needs custom C, FFI,
compiler patches, or a helper subsystem for this wrapper, stop that experiment
and compare Bun rather than working around the compiler. No third-party
runtime packages or native bridge merely to restore the old guarantees.
The zsh baseline remains acceptable if the binary adds disproportionate cost.

## Focused acceptance checks

- Parser examples produce exact seconds: `30m` -> `1800`, `1h` -> `3600`,
  `1h30m` and `90m` -> `5400`; zero components are accepted only for a positive
  total. Reject `0m`, `1`, `1s`, `1ms`, `1.5h`, `-1m`, `30m1h`, `1h1h`,
  trailing text/arguments, and values beyond the arithmetic/timeout bounds.
- Verify both command names, small help, and exact delegated arguments for
  both provisional flag mappings above, updating those expectations when the
  display-only versus combined assertion decision is confirmed.
- On macOS, verify a real foreground run, normal completion, Ctrl-C without
  leftover invoked work, and a visible nonzero launch/child failure. Use a
  short timeout in the integration harness rather than widening the public
  grammar to seconds; clean up only processes created by the check.

Keep checks proportional to a thin wrapper. No full session lifecycle suite,
private-state test harness, or unrelated packaging/CI infrastructure is required.
