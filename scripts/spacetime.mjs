import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Windows installers do not always update the current terminal's PATH.
const candidates = [process.env.SPACETIME_BIN];
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
  candidates.push(join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'bin', '2.10.2', 'spacetimedb-cli.exe'));
  candidates.push(join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe'));
}
const executable = candidates.find(p => p && existsSync(p)) ?? 'spacetime';
const child = spawn(executable, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', error => {
  console.error(`Could not run SpacetimeDB: ${error.message}\nInstall the CLI: https://spacetimedb.com/install or set SPACETIME_BIN.`);
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
