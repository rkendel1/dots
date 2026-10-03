#!/usr/bin/perl
use strict;
use warnings;
# The reworked tests hold the felt handle (`{store, state}`). These call sites
# still pass it where a WorkspaceStore is expected; add the `.store` hop.
my @sites = (
  ['tests/dot-agent-channel.test.ts', 103, 'workspace', 'opened'],
  ['tests/dot-agent-channel.test.ts', 108, 'workspace', 'opened'],
  ['tests/learning-delivery.test.ts',  78, 'workspace', 'opened'],
  ['tests/learning-delivery.test.ts', 151, 'workspace', 'opened'],
  ['tests/learning.test.ts',           99, 'ws',        'opened'],
  ['tests/runtime-scope.test.ts',      14, 'store',     'opened'],
  ['tests/runtime-scope.test.ts',      21, 'store',     'opened'],
  ['tests/runtime-scope.test.ts',      30, 'store',     'opened'],
  ['tests/runtime-scope.test.ts',      65, 'store',     'opened'],
  ['tests/runtime-scope.test.ts',      76, 'store',     'opened'],
  ['tests/runtime-scope.test.ts',      83, 'store',     'opened'],
  ['tests/tanstack-agent.test.ts',     21, 'workspace', 'opened'],
  ['tests/tanstack-agent.test.ts',     25, 'workspace', 'opened'],
  ['tests/voice.test.ts',              46, 'workspace', 'opened'],
  ['tests/page-service.test.ts',       14, 'ws',        'opened'],
  ['tests/page-service.test.ts',       38, 'ws',        'opened'],
  ['tests/page-service.test.ts',       69, 'ws',        'opened'],
  ['tests/page-service.test.ts',       92, 'ws',        'opened'],
  ['tests/page-service.test.ts',      117, 'ws',        'opened'],
  ['tests/page-service.test.ts',      131, 'ws',        'opened'],
  ['tests/page-service.test.ts',      151, 'ws',        'opened'],
  ['tests/page-service.test.ts',      158, 'ws',        'opened'],
);
my %by_file;
push @{ $by_file{ $_->[0] } }, [ $_->[1], $_->[2] ] for @sites;
for my $file (sort keys %by_file) {
  open my $in, '<', $file or die "$file: $!";
  my @lines = <$in>;
  close $in;
  for my $site (sort { $b <=> $a } @{ $by_file{$file} }) {
    my ($lineno, $var) = @$site;
    my $line = $lines[ $lineno - 1 ];
    die "$file:$lineno does not mention $var: $line"
      unless $line =~ /\b\Q$var\E\b/;
    # Replace the bare identifier (not already `.store`/`.state`) with `$var.store`.
    my $count = ($line =~ s/\b\Q$var\E(?!\.(?:store|state)\b)/$var.store/g);
    warn "$file:$lineno had no bare $var\n" unless $count;
  }
  open my $out, '>', $file or die "$file: $!";
  print $out @lines;
  close $out;
  print "patched $file\n";
}