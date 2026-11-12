#!/usr/bin/env node
// Checks that every file of every task carries the suite canary.
//
//   node scripts/check-canary.mjs [--suite CEB-2026.12] [dir ...]
//
// With no dir it checks this repository's tasks/ and template/. A dir may be anywhere,
// for example the tasks/ folder of the graders repository. For a task folder that has
// history/, the fixture is also built in a temporary folder (git am) and every file at
// its HEAD and every commit message is checked. Needs git.
// Prints JSON. Exit code 1 when a file or a commit lacks the canary.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', '__pycache__']);

function options(argv) {
  const dirs = []; let suite = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--suite') suite = argv[++i];
    else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    else dirs.push(resolve(argv[i]));
  }
  const suites = readdirSync(join(repo, 'suites')).sort();
  suite ??= suites[suites.length - 1];
  const file = join(repo, 'suites', suite ?? '', 'suite.json');
  if (!suite || !existsSync(file)) throw new Error(`no suite ${suite}: expected ${file}`);
  return { suite, canary: JSON.parse(readFileSync(file, 'utf8')).canary, dirs: dirs.length ? dirs : [join(repo, 'tasks'), join(repo, 'template')] };
}

// Every file under dir, and every folder that holds a history/ of patches.
function walk(dir, files = [], fixtures = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) { files.push(path); continue; }
    if (name === 'history' && readdirSync(path).some((f) => f.endsWith('.patch'))) fixtures.push(dir);
    walk(path, files, fixtures);
  }
  return { files, fixtures };
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=CEB', '-c', 'user.email=ceb@example.invalid', ...args], { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });

// The files and commit messages of a fixture that lack the canary, after building it from its patches.
function fixtureMissing(taskDir, needle) {
  const work = mkdtempSync(join(tmpdir(), 'ceb-canary-'));
  try {
    const patches = readdirSync(join(taskDir, 'history')).filter((f) => f.endsWith('.patch')).sort().map((f) => join(taskDir, 'history', f));
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'am', '-q', '--committer-date-is-author-date', ...patches);
    const missing = [];
    const tracked = git(work, 'ls-files', '-z').toString('utf8').split('\0').filter(Boolean);
    for (const file of tracked) if (!readFileSync(join(work, file)).includes(needle)) missing.push(`${taskDir} fixture: ${file}`);
    const commits = git(work, 'log', '--format=%H').toString('utf8').split('\n').filter(Boolean);
    for (const commit of commits) if (!git(work, 'log', '-1', '--format=%B', commit).includes(needle)) missing.push(`${taskDir} fixture: commit ${commit.slice(0, 7)}`);
    return { missing, files: tracked.length, commits: commits.length };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

try {
  const { suite, canary, dirs } = options(process.argv.slice(2));
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(canary)) throw new Error(`suite ${suite} has no canary GUID`);
  const needle = Buffer.from(canary);
  const missing = []; let files = 0; let fixtureFiles = 0; let commits = 0; let fixtures = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) throw new Error(`no folder ${dir}`);
    const found = walk(dir);
    files += found.files.length;
    for (const file of found.files) if (!readFileSync(file).includes(needle)) missing.push(file);
    for (const taskDir of found.fixtures) {
      const fixture = fixtureMissing(taskDir, needle);
      fixtures += 1; fixtureFiles += fixture.files; commits += fixture.commits;
      missing.push(...fixture.missing);
    }
  }
  console.log(JSON.stringify({ ok: missing.length === 0, suite, canary, files, fixtures, fixtureFiles, commits, missing }, null, 2));
  if (missing.length) process.exitCode = 1;
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
