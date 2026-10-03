#!/usr/bin/perl
use strict;
use warnings;
# Rework tests that held only a WorkspaceStore so they hold the felt handle.
# `memoryWorkspace` now returns {store, state} and the store owns no lifecycle.
my %specs = (
  'tests/learning.test.ts'         => 'ws',
  'tests/page-service.test.ts'     => 'ws',
  'tests/runtime-scope.test.ts'    => 'store',
  'tests/workspace.test.ts'        => 'store',
  'tests/voice.test.ts'            => 'workspace',
  'tests/learning-delivery.test.ts'=> 'workspace',
  'tests/tanstack-agent.test.ts'   => 'workspace',
  'tests/dot-agent-channel.test.ts'=> 'workspace',
);
for my $file (sort keys %specs) {
  my $v = $specs{$file};
  open my $in, '<', $file or die "$file: $!";
  local $/; my $t = <$in>; close $in;
  # 1. Park the close call behind a marker.
  $t =~ s/\b\Q$v\E\.close\(\)/__CLOSE__/g;
  # 2. Hold the handle rather than just its store.
  $t =~ s/\b\Q$v\E = \(await memoryWorkspace\([^)]*\)\)\.store;/\Q$v\E = await memoryWorkspace();/g;
  $t =~ s/\b\Q$v\E = await memoryWorkspace\('owner'\);/\Q$v\E = await memoryWorkspace('owner');/g;
  # 3. Every remaining use of the variable is a store method or the state.
  $t =~ s/\b\Q$v\E\.(?!store\b|state\b)/\Q$v\E.store./g;
  # 4. Close the felt state, which is the only lifecycle that remains.
  $t =~ s/__CLOSE__/\Q$v\E.state.close()/g;
  open my $out, '>', $file or die "$file: $!";
  print $out $t; close $out;
  print "rewrote $file\n";
}