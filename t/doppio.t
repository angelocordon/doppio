use strict;
use warnings;

use Test::More;
use Cwd qw(abs_path);
use Fcntl qw(:DEFAULT :flock);
use File::Path qw(make_path);
use File::Temp qw(tempdir);
use JSON::PP qw(decode_json);
use POSIX qw(WNOHANG);
use Time::HiRes qw(sleep time clock_gettime CLOCK_MONOTONIC);

my $script = abs_path('./doppio');
require $script;

my $tmp = tempdir(CLEANUP => 1);
local $ENV{HOME} = $tmp;
local $ENV{DOP_TEST_LOG} = "$tmp/child.json";
my $fake = "$tmp/caffeinate";
open(my $fake_fh, '>', $fake) or die $!;
print {$fake_fh} <<'FAKE';
#!/usr/bin/perl
use strict;
use warnings;
use JSON::PP qw(encode_json);
open(my $fh, '>', $ENV{DOP_TEST_LOG}) or die $!;
print {$fh} encode_json({ pid => $$, args => \@ARGV });
close($fh) or die $!;
$SIG{TERM} = sub { exit 0 };
$SIG{INT} = sub { exit 0 };
while (1) { sleep 1 }
FAKE
close($fake_fh) or die $!;
chmod(0755, $fake) == 1 or die $!;

my %children;
END {
    for my $pid (keys %children) {
        kill 'TERM', $pid;
        waitpid($pid, 0);
    }
}

sub wait_for {
    my ($check, $timeout) = @_;
    my $until = time() + ($timeout || 5);
    while (time() < $until) {
        return 1 if $check->();
        sleep 0.02;
    }
    return 0;
}

my $sequence = 0;
sub launch {
    my ($program, @args) = @_;
    my $output = "$tmp/output-" . ++$sequence;
    my $pid = fork();
    die $! unless defined $pid;
    if (!$pid) {
        open(STDOUT, '>', $output) or die $!;
        open(STDERR, '>&', \*STDOUT) or die $!;
        exec $^X, '-e', $program, $script, @args or die $!;
    }
    $children{$pid} = 1;
    return ($pid, $output);
}

my $runner = 'my $path = shift; require $path; $Doppio::CAFFEINATE = shift;'
    . ' exit Doppio::main(@ARGV);';

sub finish {
    my ($pid) = @_;
    my $status;
    my $done = wait_for(sub {
        my $result = waitpid($pid, WNOHANG);
        if ($result == $pid) {
            $status = $?;
            return 1;
        }
        return 0;
    });
    die "Timed out waiting for wrapper $pid\n" unless $done;
    delete $children{$pid};
    return $status & 127 ? 128 + ($status & 127) : $status >> 8;
}

sub slurp {
    my ($path) = @_;
    open(my $fh, '<', $path) or die "$path: $!";
    local $/;
    return <$fh>;
}

sub command {
    my (@args) = @_;
    my ($pid, $path) = launch($runner, $fake, @args);
    my $code = finish($pid);
    return ($code, slurp($path));
}

sub start_session {
    my (@args) = @_;
    unlink $ENV{DOP_TEST_LOG} if -e $ENV{DOP_TEST_LOG};
    my ($pid, $output) = launch($runner, $fake, @args);
    die "Session did not start: " . slurp($output)
        unless wait_for(sub {
            return -s $ENV{DOP_TEST_LOG} && -s "$tmp/Library/Application Support/doppio/session.json";
        });
    my $child = decode_json(slurp($ENV{DOP_TEST_LOG}));
    return ($pid, $output, $child);
}

for my $case (
    ['1h', 3600], ['30m', 1800], ['90m', 5400], ['1h30m', 5400],
    ['0h1m', 60], ['2h90m', 12600], ['000000001h', 3600],
    ['35791394m', 2147483640],
) {
    is(Doppio::parse_duration($case->[0]), $case->[1], "parse $case->[0]");
}
for my $text ('', '0m', '0h0m', '1', '-1m', '1.5h', '1H', '1m1h', '1h 30m',
    ' 1h', '1h ', '1h30m!', '--display', '35791395m', '9' x 200 . 'h') {
    my $ok = eval { Doppio::parse_duration($text); 1 };
    ok(!$ok && length($@), "reject malformed or out-of-range duration '$text'");
}
is(Doppio::format_duration(5400), '01:30:00', 'format compound duration');
is(Doppio::format_duration(360000), '100:00:00', 'format long duration');
is(Doppio::remaining(clock_gettime(CLOCK_MONOTONIC) - 1), 0, 'expired countdown is zero');
is(Doppio::remaining(clock_gettime(CLOCK_MONOTONIC) + 0.5), 1, 'round remaining time up');

my ($code, $text) = command('--help');
is($code, 0, 'help succeeds');
like($text, qr/--display/, 'help describes display flag');
for my $entry ('./dop', './doppio') {
    open(my $help, '-|', $entry, '--help') or die $!;
    my $usage = do { local $/; <$help> };
    ok(close($help), "$entry executable succeeds");
    like($usage, qr/Usage: dop/, "$entry exposes the same CLI");
}
make_path("$tmp/bin", { mode => 0700 });
is(system('/usr/bin/install', '-m', '755', $script, "$tmp/bin/doppio"), 0,
    'documented install command succeeds in an isolated directory');
symlink('doppio', "$tmp/bin/dop") or die $!;
for my $entry ("$tmp/bin/dop", "$tmp/bin/doppio") {
    open(my $help, '-|', $entry, '--help') or die $!;
    my $usage = do { local $/; <$help> };
    ok(close($help), 'installed command succeeds');
    like($usage, qr/Usage: dop/, 'installed command exposes expected CLI');
}
for my $args ([], ['-d'], ['1h', 'echo'], ['--unknown', '1h'], ['status', '1h']) {
    ($code, $text) = command(@$args);
    is($code, 1, 'invalid argument list fails');
}
($code, $text) = command('status');
is($code, 0, 'inactive status succeeds');
like($text, qr/No active/, 'inactive status is explicit');

for my $flag ('', '-d', '--display') {
    my ($pid, $output, $child) = start_session(($flag ? ($flag) : ()), '1m');
    is_deeply($child->{args},
        ['-i', ($flag ? ('-d') : ()), '-t', '60', '-w', "$pid"],
        "correct caffeinate flags for '$flag'");
    ($code, $text) = command('status');
    is($code, 0, 'active status succeeds in another process');
    like($text, qr/00:0[01]:[0-5][0-9] remaining/, 'status reports remaining time');
    like($text, $flag ? qr/system \+ display/ : qr/display may sleep/, 'status reports mode');
    my $before = decode_json(slurp("$tmp/Library/Application Support/doppio/session.json"));
    ($code, $text) = command('1m');
    is($code, 1, 'concurrent invocation is rejected');
    like($text, qr/already running/, 'concurrent invocation explains why');
    is_deeply(decode_json(slurp("$tmp/Library/Application Support/doppio/session.json")),
        $before, 'concurrent invocation does not replace active state');
    ok(kill('INT', $pid), 'send Ctrl-C signal');
    is(finish($pid), 130, 'Ctrl-C exits with 130 promptly');
    ok(!kill(0, $child->{pid}), 'Ctrl-C reaps caffeinate child');
    ok(!-e "$tmp/Library/Application Support/doppio/session.json", 'Ctrl-C removes session state');
    like(slurp($output), qr/Remaining: 00:01:00/, 'foreground countdown is shown');
    ($code, $text) = command('status');
    like($text, qr/No active/, 'no active session after Ctrl-C');
}

my $dir = Doppio::state_directory();
my $natural = 'my $path = shift; require $path; $Doppio::CAFFEINATE = shift;'
    . ' $|=1; my $dir=Doppio::state_directory();'
    . ' my $lock=Doppio::open_private("$dir/session.lock", Fcntl::O_RDWR()|Fcntl::O_CREAT());'
    . ' exit Doppio::run_session($dir,$lock,2,0);';
my ($pid, $output) = launch($natural, $fake);
is(finish($pid), 0, 'natural completion succeeds');
$text = slurp($output);
like($text, qr/Remaining: 00:00:02.*Remaining: 00:00:01/s, 'countdown decreases');
like($text, qr/Doppio finished/, 'completion is explicit');
ok(!-e "$dir/session.json", 'completion clears state');
my $child = decode_json(slurp($ENV{DOP_TEST_LOG}));
ok(!kill(0, $child->{pid}), 'completion reaps caffeinate');

Doppio::write_state($dir, { deadline => 999999999, display => 1 });
($code, $text) = command('status');
like($text, qr/No active/, 'stale state without a held lock is ignored');
($pid, $output, $child) = start_session('1m');
ok(kill('TERM', $pid), 'send termination signal');
is(finish($pid), 143, 'SIGTERM cleans up and exits with 143');
ok(!kill(0, $child->{pid}), 'SIGTERM reaps child');
ok(!-e "$dir/session.json", 'stale state is replaced and cleaned up');

($pid, $output, $child) = start_session('1m');
ok(kill('HUP', $pid), 'simulate closing the terminal');
is(finish($pid), 129, 'SIGHUP cleans up and exits with 129');
ok(!kill(0, $child->{pid}), 'SIGHUP reaps child');
ok(!-e "$dir/session.json", 'SIGHUP clears state');

($pid, $output, $child) = start_session('1m');
ok(kill('TERM', $child->{pid}), 'simulate unexpected caffeinate exit');
is(finish($pid), 1, 'unexpected child exit fails');
like(slurp($output), qr/caffeinate exited before/, 'unexpected child exit is visible');
ok(!-e "$dir/session.json", 'unexpected child exit clears state');

($pid, $output) = launch($runner, "$tmp/missing-caffeinate", '1m');
is(finish($pid), 1, 'exec failure fails the wrapper');
like(slurp($output), qr/Cannot execute caffeinate/, 'exec error is surfaced');
ok(!-e "$dir/session.json", 'exec failure clears state');

my $held = Doppio::open_private("$dir/session.lock", O_RDWR | O_CREAT);
flock($held, LOCK_EX | LOCK_NB) or die $!;
open(my $bad, '>', "$dir/session.json") or die $!;
print {$bad} '{broken';
close($bad) or die $!;
chmod(0600, "$dir/session.json") == 1 or die $!;
($code, $text) = command('status');
is($code, 1, 'malformed active state fails explicitly');
like($text, qr/Invalid session state/, 'malformed state is diagnosed');
unlink("$dir/session.json") or die $!;
POSIX::mkfifo("$dir/session.json", 0600) == 0 or die $!;
my $before_fifo = time();
($code, $text) = command('status');
is($code, 1, 'FIFO active state is rejected instead of blocking');
like($text, qr/Unsafe state file/, 'FIFO state is diagnosed');
cmp_ok(time() - $before_fifo, '<', 2, 'unsafe FIFO state fails promptly');
close($held) or die $!;
unlink("$dir/session.json") or die $!;

chmod(0755, $dir) == 1 or die $!;
($code, $text) = command('1m');
is($code, 1, 'non-private state directory is rejected');
like($text, qr/Unsafe state directory/, 'unsafe directory is diagnosed');
chmod(0700, $dir) == 1 or die $!;
unlink("$dir/session.lock") or die $!;
symlink("$tmp/unrelated", "$dir/session.lock") or die $!;
($code, $text) = command('status');
is($code, 1, 'symlink lock file is rejected');
ok(!-e "$tmp/unrelated", 'symlink target is not created');
unlink("$dir/session.lock") or die $!;

SKIP: {
    skip 'real caffeinate smoke tests require macOS', 21 unless $^O eq 'darwin';
    for my $flag ('', '--display') {
        ($pid, $output) = launch($runner, '/usr/bin/caffeinate',
            ($flag ? ($flag) : ()), '1m');
        ok(wait_for(sub { -s "$dir/session.json" }), 'real caffeinate session starts');
        sleep 0.3;
        open(my $ps, '-|', '/bin/ps', '-axo', 'pid=,ppid=,comm=') or die $!;
        my @processes = <$ps>;
        close($ps) or die 'ps failed';
        my ($child_pid) = map { /^\s*([0-9]+)\s+$pid\s+.*caffeinate\s*$/ ? $1 : () } @processes;
        ok($child_pid, "identify only this wrapper's real caffeinate child");
        open(my $assertions, '-|', '/usr/bin/pmset', '-g', 'assertions') or die $!;
        my $report = do { local $/; <$assertions> };
        close($assertions) or die 'pmset failed';
        like($report, qr/pid $child_pid\(caffeinate\).*PreventUserIdleSystemSleep/,
            'real child holds idle system sleep assertion');
        if ($flag) {
            like($report, qr/pid $child_pid\(caffeinate\).*PreventUserIdleDisplaySleep/,
                'display mode holds idle display sleep assertion');
        } else {
            unlike($report, qr/pid $child_pid\(caffeinate\).*PreventUserIdleDisplaySleep/,
                'default mode does not hold idle display sleep assertion');
        }
        ($code, $text) = command('status');
        like($text, qr/remaining/, 'real session status is active');
        ok(kill('INT', $pid), 'interrupt real caffeinate wrapper');
        is(finish($pid), 130, 'real caffeinate wrapper releases assertions');
        ok(!$child_pid || !kill(0, $child_pid), 'real caffeinate child is gone');
    }
    ($pid, $output) = launch($runner, '/usr/bin/caffeinate', '1m');
    ok(wait_for(sub { -s "$dir/session.json" }), 'real crash test starts');
    sleep 0.3;
    open(my $ps, '-|', '/bin/ps', '-axo', 'pid=,ppid=,comm=') or die $!;
    my @processes = <$ps>;
    close($ps) or die 'ps failed';
    my ($orphan) = map { /^\s*([0-9]+)\s+$pid\s+.*caffeinate\s*$/ ? $1 : () } @processes;
    ok($orphan, 'identify crash-test child');
    kill('KILL', $pid) or die "Cannot simulate wrapper crash: $!";
    is(finish($pid), 137, 'wrapper is force-killed');
    ok(wait_for(sub { $orphan && !kill(0, $orphan) }), '-w releases real child after wrapper crash');
    ($code, $text) = command('status');
    like($text, qr/No active/, 'real smoke tests ignore stale crash state');
}

done_testing();
