import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Quota queries (`-p /usage`, `codex app-server`) get no answer from the stand-ins below,
// and don't count as runs.
const SKIP_QUOTA = 'case "$1 $2" in "-p /usage" | app-server*) exit 0 ;; esac';

/** A stand-in CLI that ignores its arguments and replays a recorded stream from fixtures/. */
export function fakeCli(fixture: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'harness-fake-')), 'cli');
  writeFileSync(bin, `#!/bin/sh\n${SKIP_QUOTA}\ncat > /dev/null\ncat "${resolve(__dirname, '../src/test/fixtures', fixture)}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A stand-in CLI that answers anything, quota queries included, with a recorded reply (stdin unread). */
export function fakeReplyCli(fixture: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'harness-fake-')), 'cli');
  writeFileSync(bin, `#!/bin/sh\ncat "${resolve(__dirname, '../src/test/fixtures', fixture)}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Like fakeCli, but each run replays the next fixture (the last one repeats). `--version` doesn't count. */
export function fakeCliSeq(fixtures: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-fake-'));
  const bin = join(dir, 'cli');
  const cases = fixtures.map((f, i) => `  ${i === fixtures.length - 1 ? '*' : i}) f="${resolve(__dirname, '../src/test/fixtures', f)}" ;;`).join('\n');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "0.0.0-fake"; exit 0; fi',
      SKIP_QUOTA,
      'cat > /dev/null',
      `n=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > "${dir}/count"`,
      'case $n in',
      cases,
      'esac',
      'cat "$f"',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return bin;
}
