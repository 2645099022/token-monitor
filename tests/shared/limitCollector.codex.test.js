'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { codexCommandCandidates, codexCommandSourceDetail, mapCodexRateLimitsToProvider } = require('../../src/shared/limitCollector');

function dirent(name, directory = true) {
  return {
    name,
    isDirectory: () => directory
  };
}

test('Codex command candidates include Microsoft Store app installs on Windows', () => {
  const programFiles = 'C:\\Program Files';
  const appxDir = path.win32.join(programFiles, 'WindowsApps');
  const oldAppxPackage = 'OpenAI.Codex_26.601.2237.0_x64__2p2nqsd0c76g0';
  const appxPackage = 'OpenAI.Codex_26.602.4764.0_x64__2p2nqsd0c76g0';
  const expectedResourceCli = path.win32.join(appxDir, appxPackage, 'app', 'resources', 'codex.exe');
  const expectedAppExe = path.win32.join(appxDir, appxPackage, 'app', 'Codex.exe');
  const oldAppExe = path.win32.join(appxDir, oldAppxPackage, 'app', 'Codex.exe');

  const candidates = codexCommandCandidates({
    ProgramFiles: programFiles,
    APPDATA: 'C:\\Users\\Javis\\AppData\\Roaming'
  }, 'win32', {
    readdirSync: (dir) => {
      assert.equal(dir, appxDir);
      return [dirent(oldAppxPackage), dirent(appxPackage), dirent('Other.App_1.0.0_x64__id')];
    }
  });

  assert.equal(candidates.includes(expectedResourceCli), true);
  assert.equal(candidates.includes(expectedAppExe), true);
  assert.ok(candidates.indexOf(expectedResourceCli) < candidates.indexOf(expectedAppExe));
  assert.ok(candidates.indexOf(expectedResourceCli) < candidates.indexOf(oldAppExe));
});

test('Codex command candidates include app-managed local binaries on Windows', () => {
  const localAppData = 'C:\\Users\\Javis\\AppData\\Local';
  const localBin = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const packageBin = path.win32.join(
    localAppData,
    'Packages',
    'OpenAI.Codex_2p2nqsd0c76g0',
    'LocalCache',
    'Local',
    'OpenAI',
    'Codex',
    'bin'
  );
  const expectedLocal = path.win32.join(localBin, 'codex.exe');
  const expectedLocalVersioned = path.win32.join(localBin, '716dda49c14d31a0', 'codex.exe');
  const expectedPackage = path.win32.join(packageBin, 'codex.exe');
  const expectedAlias = path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe');
  const impossibleNodeCandidate = path.win32.join(localBin, 'node.exe', 'codex.exe');
  const impossibleCodexExeCandidate = path.win32.join(localBin, 'codex.exe', 'codex.exe');

  const candidates = codexCommandCandidates({
    LOCALAPPDATA: localAppData
  }, 'win32', {
    readdirSync: (dir) => {
      if (dir === localBin) {
        return [
          dirent('716dda49c14d31a0'),
          dirent('codex.exe', false),
          dirent('node.exe', false),
          dirent('rg.exe', false)
        ];
      }
      if (dir === path.win32.join(localAppData, 'Packages')) {
        return [dirent('OpenAI.Codex_2p2nqsd0c76g0'), dirent('Other.App')];
      }
      if (dir === packageBin) return [];
      return [];
    }
  });

  assert.equal(candidates.includes(expectedLocal), true);
  assert.equal(candidates.includes(expectedLocalVersioned), true);
  assert.equal(candidates.includes(expectedPackage), true);
  assert.equal(candidates.includes(impossibleNodeCandidate), false);
  assert.equal(candidates.includes(impossibleCodexExeCandidate), false);
  assert.ok(candidates.indexOf(expectedLocal) < candidates.indexOf(expectedAlias));
});

test('Codex command source detail separates app-managed binaries from CLI commands', () => {
  assert.equal(
    codexCommandSourceDetail('C:\\Users\\Javis\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe', 'win32'),
    'app'
  );
  assert.equal(
    codexCommandSourceDetail('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.602.4764.0_x64__id\\app\\resources\\codex.exe', 'win32'),
    'app'
  );
  assert.equal(
    codexCommandSourceDetail('C:\\Users\\Javis\\AppData\\Roaming\\npm\\codex.cmd', 'win32'),
    'cli'
  );
  assert.equal(codexCommandSourceDetail('codex.cmd', 'win32'), 'cli');
  assert.equal(codexCommandSourceDetail('/Applications/Codex.app/Contents/Resources/codex', 'darwin'), 'app');
});

test('Codex provider preserves source detail for renderer labels', () => {
  const provider = mapCodexRateLimitsToProvider({
    account: { planType: 'plus' },
    rateLimits: {
      primary: {
        usedPercent: 12,
        resetsAt: '2026-06-01T00:00:00Z',
        windowDurationMins: 300
      }
    }
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.source, 'rpc');
  assert.equal(provider.sourceDetail, 'app');
});
