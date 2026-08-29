import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { makeProject, ids } from './helpers.js';

test('unreal: .uproject detected, plugin dir counts as SDK', (t) => {
  const bare = makeProject(t, { 'MyGame.uproject': '{ "EngineAssociation": "5.3" }\n' });
  const scanBare = scanProject(bare);
  assert.equal(scanBare.engine, 'unreal');
  assert.ok(ids(scanBare.findings).includes('sdk_missing'));

  const withPlugin = makeProject(t, {
    'MyGame.uproject': '{ "EngineAssociation": "5.3" }\n',
    'Plugins/Ravensight/Ravensight.uplugin': '{ "FriendlyName": "Ravensight" }\n',
    'Source/MyGame/Stats.cpp': 'void OnWin() { Analytics->Track(TEXT("run_won")); }\n',
  });
  const scan = scanProject(withPlugin);
  assert.equal(scan.engine, 'unreal');
  assert.ok(!ids(scan.findings).includes('sdk_missing'));
  assert.ok(!ids(scan.findings).includes('no_track_calls'));
});

test('unity: Assets plus ProjectSettings detected, Ravensight.cs counts as SDK', (t) => {
  const bare = makeProject(t, {
    'Assets/scene.unity': 'placeholder\n',
    'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.1f1\n',
  });
  const scanBare = scanProject(bare);
  assert.equal(scanBare.engine, 'unity');
  assert.ok(ids(scanBare.findings).includes('sdk_missing'));

  const withSdk = makeProject(t, {
    'Assets/scene.unity': 'placeholder\n',
    'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.1f1\n',
    'Assets/Ravensight/Ravensight.cs': 'namespace RealitySE { public static class Ravensight {} }\n',
    'Assets/Scripts/Level.cs': 'void Clear() { Ravensight.Track("level_completed"); }\n',
  });
  const scan = scanProject(withSdk);
  assert.equal(scan.engine, 'unity');
  assert.ok(!ids(scan.findings).includes('sdk_missing'));
  assert.ok(!ids(scan.findings).includes('no_track_calls'));
});

test('ios: Podfile detected; Package.swift needs a Ravensight mention', (t) => {
  const pod = makeProject(t, { Podfile: "pod 'Ravensight'\n" });
  assert.equal(scanProject(pod).engine, 'ios');

  const spm = makeProject(t, {
    'Package.swift': '// swift-tools-version:5.9\n// depends on Ravensight\n',
  });
  assert.equal(scanProject(spm).engine, 'ios');

  const plain = makeProject(t, { 'Package.swift': '// swift-tools-version:5.9\n' });
  assert.equal(scanProject(plain).engine, 'custom');
});

test('android: build.gradle with the android plugin', (t) => {
  const dir = makeProject(t, {
    'build.gradle': "plugins { id 'com.android.application' }\n",
    'app/src/main/java/Game.kt': 'fun onBoot() { ravensight.track("game_started") }\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'android');
  assert.ok(ids(scan.findings).includes('sdk_missing'));
});

test('javascript: package.json without a ravensight dependency is sdk_missing', (t) => {
  const dir = makeProject(t, {
    'package.json': '{ "name": "some-game", "dependencies": { "phaser": "^3.0.0" } }\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'javascript');
  assert.ok(ids(scan.findings).includes('sdk_missing'));
});

test('odin: .odin files detected anywhere in the tree', (t) => {
  const dir = makeProject(t, { 'src/main.odin': 'main :: proc() {}\n' });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'odin');
  assert.ok(ids(scan.findings).includes('sdk_missing'));
});

test('cpp: CMakeLists.txt mentioning ravensight', (t) => {
  const dir = makeProject(t, {
    'CMakeLists.txt': 'project(mygame)\nadd_subdirectory(vendor/ravensight)\n',
    'src/main.cpp': 'int main() { rs.track("game_started"); }\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'cpp');
  assert.ok(!ids(scan.findings).includes('sdk_missing'));
});

test('cpp: CMakeLists.txt without ravensight falls through to custom', (t) => {
  const dir = makeProject(t, { 'CMakeLists.txt': 'project(mygame)\n' });
  assert.equal(scanProject(dir).engine, 'custom');
});

test('empty directory is custom with no sdk_missing', (t) => {
  const dir = makeProject(t, { 'README.txt': 'nothing here\n' });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'custom');
  assert.ok(!ids(scan.findings).includes('sdk_missing'));
});

test('precedence: project.godot wins over package.json', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'package.json': '{ "name": "tooling" }\n',
  });
  assert.equal(scanProject(dir).engine, 'godot');
});
