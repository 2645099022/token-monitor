'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const platformArch = `${process.platform}-${process.arch}`;
const nodeAbi = process.versions.modules;
const nativePackage = path.join(root, 'node_modules', 'better-sqlite3');
const runtimeRoot = path.join(root, 'native', 'runtime', platformArch);
const nodeRuntimeRoot = path.join(runtimeRoot, `node-${nodeAbi}`);
const buildRoot = path.join(root, 'tmp', 'native-runtime-build', `${platformArch}-node-${nodeAbi}`);

function fail(message) {
  throw new Error(`[native] ${message}`);
}

function runNode(label, script, args, cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited with status ${result.status}`);
}

function copyNativeBinding(source, destinationRoot) {
  if (!fs.existsSync(source)) fail(`missing native binding: ${source}`);
  fs.mkdirSync(destinationRoot, { recursive: true });
  const destination = path.join(destinationRoot, 'better_sqlite3.node');
  fs.copyFileSync(source, destination);
  return destination;
}

function canLoadNativeBinding(source) {
  const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(source)});`], {
    stdio: 'ignore',
    windowsHide: true
  });
  return !probe.error && probe.status === 0;
}

function buildNodeBinding() {
  if (!fs.existsSync(nativePackage)) fail('better-sqlite3 is not installed');
  const installedBinding = path.join(nativePackage, 'build', 'Release', 'better_sqlite3.node');
  if (canLoadNativeBinding(installedBinding)) return copyNativeBinding(installedBinding, nodeRuntimeRoot);
  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(buildRoot, { recursive: true });
  for (const name of ['binding.gyp', 'package.json']) {
    fs.copyFileSync(path.join(nativePackage, name), path.join(buildRoot, name));
  }
  for (const name of ['src', 'deps']) {
    fs.cpSync(path.join(nativePackage, name), path.join(buildRoot, name), { recursive: true });
  }
  const nodeGyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  if (!fs.existsSync(nodeGyp)) fail('node-gyp is not installed');
  runNode('Node native build', nodeGyp, ['rebuild', '--release'], buildRoot);
  return copyNativeBinding(
    path.join(buildRoot, 'build', 'Release', 'better_sqlite3.node'),
    nodeRuntimeRoot
  );
}

function buildElectronBinding() {
  const electronRebuild = path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  const electronAbiPath = path.join(root, 'node_modules', 'electron', 'abi_version');
  if (!fs.existsSync(electronRebuild) || !fs.existsSync(electronAbiPath)) {
    return null;
  }
  runNode('Electron native rebuild', electronRebuild, ['--force', '--which-module', 'better-sqlite3']);
  const electronAbi = fs.readFileSync(electronAbiPath, 'utf8').trim();
  return copyNativeBinding(
    path.join(nativePackage, 'build', 'Release', 'better_sqlite3.node'),
    path.join(runtimeRoot, `electron-${electronAbi}`)
  );
}

function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    fail(`Node.js >=22.13.0 is required; found ${process.version}`);
  }
  const nodeBinding = buildNodeBinding();
  const electronBinding = process.argv.includes('--node-only') ? null : buildElectronBinding();
  fs.rmSync(buildRoot, { recursive: true, force: true });
  console.log(`[native] Node ABI ${nodeAbi}: ${nodeBinding}`);
  if (electronBinding) console.log(`[native] Electron ABI ${fs.readFileSync(path.join(root, 'node_modules', 'electron', 'abi_version'), 'utf8').trim()}: ${electronBinding}`);
}

main();
