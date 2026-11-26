'use strict';

const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildRefTree, readRefs, openHistory, readHistory, readCommitDiff, readCommitFiles, readCommitFileDiff,
  readCommitFileComparison, findHistoryMatch, resolveCommit, readBranchTipsContaining, readRemoteTagNames,
} = require('../src/git');
const { BranchFilter } = require('../src/branchFilter');
const { BranchColors } = require('../src/branchColors');
const { layoutGraph, graphLayout, nextDiffSelection } = require('../media/graph');

test('streams commit pages past the command output buffer limit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'git-plus-plus-history-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const count = 6500;
  const subject = 'á'.repeat(1350);
  const commits = Array.from({ length: count }, (_, index) => {
    const message = `${index === 0 ? 'Oldest match ' : ''}${subject}`;
    return `commit refs/heads/main\ncommitter Tester <test@example.invalid> ${1700000000 + index} +0000\n` +
      `data ${Buffer.byteLength(message)}\n${message}\n\n`;
  }).join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: commits });
  const tip = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: root, encoding: 'utf8' }).trim();
  const history = openHistory(root, 'git', [tip]);
  try {
    const first = await history.read(200);
    assert.equal(first.commits.length, 200);
    assert.equal(first.hasMore, true);
    assert.equal(first.commits[0].subject, subject);
    const match = await findHistoryMatch(root, 'git', [tip], 'Oldest match');
    assert.equal(match.position, count);
    let previous = first.commits.at(-1);
    for (let offset = 200; offset < count; offset += 200) {
      const page = await history.read(offset + 200, offset);
      assert.equal(page.commits.length, Math.min(200, count - offset));
      assert.equal(previous.parents[0], page.commits[0].hash);
      assert.equal(page.hasMore, offset + 200 < count);
      previous = page.commits.at(-1);
    }
    assert.equal(previous.hash, match.hash);
    assert.equal(previous.subject, `Oldest match ${subject}`);
  } finally {
    history.close();
  }
});

test('reads tag refs across remotes without mistaking an unreachable remote for an empty one', async t => {
  const root = mkdtempSync(join(tmpdir(), 'git-plus-plus-tags-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  function git(...args) {
    execFileSync('git', [
      '-c', 'user.name=Tester', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args,
    ], { cwd: root });
  }

  git('init', '-q');
  git('commit', '--allow-empty', '-qm', 'Initial commit');
  git('tag', 'release/lightweight');
  git('tag', '-a', 'release/annotated', '-m', 'Annotated tag');
  git('tag', 'local');
  for (const [remote, tag] of [['origin', 'release/lightweight'], ['archive', 'release/annotated']]) {
    const path = join(root, `${remote}.git`);
    git('init', '-q', '--bare', path);
    git('remote', 'add', remote, path);
    git('push', '-q', remote, `refs/tags/${tag}`);
  }
  assert.deepEqual(await readRemoteTagNames(root, 'git', []), new Set());
  assert.deepEqual(await readRemoteTagNames(root, 'git', ['origin', 'archive']), new Set([
    'refs/tags/release/lightweight', 'refs/tags/release/annotated',
  ]));
  git('remote', 'add', 'unreachable', join(root, 'missing.git'));
  assert.equal(await readRemoteTagNames(root, 'git', ['origin', 'unreachable']), undefined);
});

test('reads an empty repository and a merged history with branches and tags', async t => {
  const root = mkdtempSync(join(tmpdir(), 'git-plus-plus-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  function git(...args) {
    return execFileSync('git', [
      '-c', 'user.name=Git Plus Plus', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args,
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  function commit(subject, ...options) {
    git('commit', '--allow-empty', '-qm', subject, ...options);
    return git('rev-parse', 'HEAD');
  }

  git('init', '-q', '-b', 'main');
  assert.deepEqual(await readRefs(root, 'git'), []);
  assert.deepEqual(await readHistory(root, 'git', 10), { commits: [], hasMore: false });

  const first = commit('Initial commit', '--date=2001-01-01T01:00:00+08:00');
  git('checkout', '-qb', 'feature/ui');
  writeFileSync(join(root, 'interface.txt'), 'New interface\n');
  git('add', 'interface.txt');
  const feature = commit('Build the interface', '-m', 'Searchable body [literal]');
  git('tag', 'release/v1.0', first);
  git('-c', 'user.name=Release Bot', 'tag', '-a', 'release/v2.0', '-m', 'Version 2');
  git('checkout', '-q', 'main');
  const main = commit('main');
  const mergeSubject = 'Merge the UI branch \u{1F680}';
  git('merge', '-q', '--no-ff', 'feature/ui', '-m', mergeSubject);
  const merge = git('rev-parse', 'HEAD');
  assert.match(await readCommitDiff(root, 'git', merge, main), /\+New interface/);
  assert.equal(await readCommitDiff(root, 'git', merge, feature), '');
  git('update-ref', 'refs/remotes/origin/main', merge);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('tag', 'tree-only', 'HEAD^{tree}');

  const refs = await readRefs(root, 'git');
  assert.equal(refs.find(ref => ref.current).name, 'main');
  assert.equal(refs.find(ref => ref.group === 'remotes').name, 'origin/main');
  assert.equal(refs.some(ref => ref.name === 'origin/HEAD'), false);
  const tags = buildRefTree(refs.filter(ref => ref.group === 'tags'));
  assert.deepEqual(tags.map(({ label }) => label), ['tree-only', 'release']);
  const releaseTags = tags[1].children;
  assert.deepEqual(releaseTags.map(({ ref }) => [ref.name, ref.author, ref.hash]), [
    ['release/v1.0', 'Git Plus Plus', first],
    ['release/v2.0', 'Release Bot', feature],
  ]);
  const [lightweight, annotated] = releaseTags;
  assert.equal(lightweight.ref.tagger, undefined);
  assert.equal(annotated.ref.tagger, 'Release Bot');
  assert.equal(lightweight.ref.taggerDate, undefined);
  assert.equal(annotated.ref.taggerDate, git('for-each-ref', '--format=%(taggerdate:iso-strict)', annotated.ref.fullName));
  assert.equal(await resolveCommit(root, 'git', 'refs/tags/release/v2.0'), feature);
  await assert.rejects(resolveCommit(root, 'git', 'refs/tags/tree-only'));

  const short = await readHistory(root, 'git', 2);
  assert.equal(short.hasMore, true);
  assert.equal(short.commits.length, 2);
  assert.equal(short.commits[0].subject, mergeSubject);
  assert.deepEqual(short.commits[0].parents, [main, feature]);
  assert.equal(short.commits.some(commit => commit.hash === first), false);
  const fullOrder = await readHistory(root, 'git', 10, [merge]);
  const position = fullOrder.commits.findIndex(commit => commit.hash === feature) + 1;
  assert.deepEqual(await findHistoryMatch(root, 'git', [merge], 'BODY [LITERAL]'), { hash: feature, position });
  assert.deepEqual(await findHistoryMatch(root, 'git', [merge], feature.slice(0, 12).toUpperCase()), { hash: feature, position });
  assert.equal(await findHistoryMatch(root, 'git', [main], 'Searchable body'), undefined);
  assert.equal(await findHistoryMatch(root, 'git', [], 'Initial commit'), undefined);
  const firstParent = { firstParent: true };
  const linear = await readHistory(root, 'git', 10, [merge], firstParent);
  assert.deepEqual(linear.commits.map(commit => commit.hash), [merge, main, first]);
  assert.deepEqual(linear.commits[0].parents, [main, feature]);
  assert.equal(await findHistoryMatch(root, 'git', [merge], 'Searchable body', firstParent), undefined);
  assert.deepEqual(await findHistoryMatch(root, 'git', [merge], 'Initial commit', firstParent), { hash: first, position: 3 });
  const multiTip = await readHistory(root, 'git', 10, [merge, feature], firstParent);
  assert.ok(multiTip.commits.some(commit => commit.hash === feature));
  const scoped = await readHistory(root, 'git', 2, first);
  assert.deepEqual(scoped.commits.map(commit => commit.hash), [first]);
  assert.equal(scoped.commits[0].shortHash, git('show', '-s', '--abbrev=8', '--format=%h', first));
  assert.equal(scoped.commits[0].date, git('show', '-s', '--format=%cI', first));
  assert.notEqual(scoped.commits[0].date, git('show', '-s', '--format=%aI', first));
  assert.equal(scoped.hasMore, false);

  git('checkout', '-q', '--detach', first);
  const detached = commit('detached');
  const full = await readHistory(root, 'git', 10);
  assert.equal(full.hasMore, false);
  assert.equal(full.commits.some(commit => commit.hash === detached), true);
  assert.equal(full.commits.at(-1).hash, first);

  git('update-ref', 'refs/remotes/origin/topic', detached);
  assert.deepEqual(await readHistory(root, 'git', 10, []), { commits: [], hasMore: false });
  const filtered = await readHistory(root, 'git', 10, [feature, detached]);
  assert.deepEqual(new Set(filtered.commits.map(commit => commit.hash)), new Set([feature, detached, first]));
  assert.equal(filtered.commits.filter(commit => commit.hash === first).length, 1);
  assert.deepEqual(await readBranchTipsContaining(root, 'git', detached), new Set([detached]));
  assert.equal((await readBranchTipsContaining(root, 'git', first)).has(merge), true);

  git('remote', 'add', 'origin', join(root, 'unused-remote.git'));
  git('update-ref', 'refs/remotes/origin/main', main);
  git('update-ref', 'refs/remotes/origin/feature', feature);
  git('branch', '--set-upstream-to=origin/main', 'main');
  git('branch', '--set-upstream-to=origin/feature', 'feature/ui');
  git('branch', 'local-tracking', first);
  git('branch', '--set-upstream-to=main', 'local-tracking');
  git('switch', 'main');
  const tracking = await readRefs(root, 'git');
  const current = tracking.find(ref => ref.current);
  assert.equal(current.upstream, 'refs/remotes/origin/main');
  assert.deepEqual([current.ahead, current.behind], [2, 0]);
  const synced = tracking.find(ref => ref.fullName === 'refs/heads/feature/ui');
  assert.deepEqual([synced.ahead, synced.behind], [0, 0]);
  const localTracking = tracking.find(ref => ref.fullName === 'refs/heads/local-tracking');
  assert.deepEqual([localTracking.ahead, localTracking.behind], [undefined, undefined]);

  git('update-ref', 'refs/remotes/origin/main', detached);
  git('update-ref', 'refs/remotes/origin/feature', merge);
  const diverged = await readRefs(root, 'git');
  const [mainBranch, featureBranch] = [
    diverged.find(ref => ref.current),
    diverged.find(ref => ref.fullName === 'refs/heads/feature/ui'),
  ];
  assert.deepEqual([mainBranch.ahead, mainBranch.behind], [3, 1]);
  assert.deepEqual([featureBranch.ahead, featureBranch.behind], [0, 2]);

  git('update-ref', '-d', 'refs/remotes/origin/main');
  const gone = (await readRefs(root, 'git')).find(ref => ref.current);
  assert.deepEqual([gone.ahead, gone.behind], [undefined, undefined]);

  mkdirSync(join(root, 'nested'));
  const renamedPath = 'nested/ui [draft].txt';
  const addedPath = 'nested/notes [draft].txt';
  git('mv', 'interface.txt', renamedPath);
  writeFileSync(join(root, addedPath), 'Unrelated addition\n');
  git('add', '--', addedPath);
  const renamedCommit = commit('Rename interface');
  const changed = await readCommitFiles(root, 'git', renamedCommit, merge);
  const renamedFile = changed.find(file => file.path === renamedPath);
  const addedFile = changed.find(file => file.path === addedPath);
  assert.deepEqual(renamedFile, { status: 'R', path: renamedPath, oldPath: 'interface.txt' });
  assert.deepEqual(addedFile, { status: 'A', path: addedPath });
  const renamePatch = await readCommitFileDiff(root, 'git', renamedCommit, merge, renamedFile);
  assert.match(renamePatch, /rename from interface\.txt/);
  assert.doesNotMatch(renamePatch, /Unrelated addition/);
  assert.deepEqual(await readCommitFileComparison(root, 'git', renamedCommit, merge, renamedFile), {
    before: 'New interface\n', after: 'New interface\n',
  });
  assert.match(await readCommitFileDiff(root, 'git', renamedCommit, merge, addedFile), /\+Unrelated addition/);

  const binaryPath = 'binary.dat';
  writeFileSync(join(root, binaryPath), Buffer.from([0, 1, 2, 0]));
  git('add', '--', binaryPath);
  const binaryCommit = commit('Add binary file');
  const [binaryFile] = await readCommitFiles(root, 'git', binaryCommit, renamedCommit);
  const binary = await readCommitFileComparison(root, 'git', binaryCommit, renamedCommit, binaryFile);
  assert.match(binary.patch, /Binary files .* differ/);
  assert.equal(binary.before, undefined);
  assert.equal(binary.after, undefined);

  writeFileSync(join(root, '.gitattributes'), 'opaque.txt -diff\n');
  writeFileSync(join(root, 'opaque.txt'), 'Text marked as binary by Git\n');
  git('add', '--', '.gitattributes', 'opaque.txt');
  const opaqueCommit = commit('Add text marked as binary');
  const opaque = (await readCommitFiles(root, 'git', opaqueCommit, binaryCommit)).find(file => file.path === 'opaque.txt');
  assert.match((await readCommitFileComparison(root, 'git', opaqueCommit, binaryCommit, opaque)).patch, /Binary files .* differ/);
});

test('branch filters default to the current local branch and remember an empty selection per repository', () => {
  const stored = new Map();
  const storage = {
    get: key => stored.get(key),
    update(key, value) { stored.set(key, value); return Promise.resolve(); },
  };
  const output = { appendLine: assert.fail };
  const filter = new BranchFilter(storage, output);
  const local = { group: 'heads', fullName: 'refs/heads/main', current: true };
  const remote = { group: 'remotes', fullName: 'refs/remotes/origin/main', current: false };
  const tag = { group: 'tags', fullName: 'refs/tags/v1', current: false };
  const refs = [local, remote, tag];
  assert.deepEqual(filter.selected('/repo', refs), [local]);
  assert.equal(filter.change('/repo', refs, tag.fullName, true), false);
  assert.equal(filter.change('/repo', refs, remote.fullName, true), true);
  assert.deepEqual(filter.selected('/repo', refs), [local, remote]);
  assert.equal(filter.change('/repo', refs, local.fullName, false), true);
  assert.equal(filter.change('/repo', refs, remote.fullName, false), true);
  const reopened = new BranchFilter(storage, output);
  assert.deepEqual(reopened.selected('/repo', refs), []);
  assert.deepEqual(reopened.selected('/other', refs), [local]);
});

test('group selection updates only the requested branch group in one write', () => {
  const writes = [];
  const storage = {
    get: () => undefined,
    update(key, value) { writes.push(value); return Promise.resolve(); },
  };
  const filter = new BranchFilter(storage, { appendLine: assert.fail });
  const refs = [
    { group: 'heads', fullName: 'refs/heads/main', current: true },
    { group: 'heads', fullName: 'refs/heads/feature/ui' },
    { group: 'remotes', remote: 'origin', fullName: 'refs/remotes/origin/main' },
    { group: 'remotes', remote: 'backup', fullName: 'refs/remotes/backup/feature/ui' },
    { group: 'tags', fullName: 'refs/tags/v1' },
  ];
  assert.equal(filter.changeGroup('/repo', refs, 'remotes/origin', true), true);
  assert.equal(writes.length, 1);
  assert.deepEqual(filter.selected('/repo', refs), [refs[0], refs[2]]);
  assert.equal(filter.changeGroup('/repo', refs, 'heads', true), true);
  assert.equal(filter.changeGroup('/repo', refs, 'heads', true), false);
  assert.equal(filter.changeGroup('/repo', refs, 'tags', true), false);
  assert.equal(writes.length, 2);
  assert.equal(filter.changeGroup('/repo', refs, 'remotes/backup', true), true);
  assert.deepEqual(filter.selected('/repo', refs), refs.slice(0, 4));
  assert.equal(filter.changeGroup('/repo', refs, 'heads', false), true);
  assert.deepEqual(filter.selected('/repo', refs), refs.slice(2, 4));
  assert.equal(filter.changeGroup('/repo', refs, 'remotes/origin', false), true);
  assert.deepEqual(filter.selected('/repo', refs), [refs[3]]);
  assert.equal(filter.changeGroup('/repo', refs, 'remotes/backup', false), true);
  assert.deepEqual(filter.selected('/repo', refs), []);
  assert.equal(writes.length, 6);
});

test('Command-click selects two commits and replaces the second endpoint', () => {
  const first = nextDiffSelection([], 'a', false);
  const pair = nextDiffSelection(first, 'b', true);
  assert.deepEqual(pair, ['a', 'b']);
  assert.deepEqual(nextDiffSelection(pair, 'c', true), ['a', 'c']);
  assert.deepEqual(nextDiffSelection(pair, 'a', true), ['b']);
  assert.deepEqual(nextDiffSelection(pair, 'a', false), ['a']);
  assert.deepEqual(nextDiffSelection(first, 'a', false), []);
});

test('draws both merge edges and joins both lanes at the shared ancestor', () => {
  const commits = [
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'feature', parents: ['base'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const [merge, feature, main, base] = layoutGraph(commits);
  assert.deepEqual(merge.edges.map(edge => [edge.from, edge.to]), [[0, 0], [0, 1]]);
  assert.deepEqual(feature.incoming.map(lane => lane.hash), ['main', 'feature']);
  assert.deepEqual(main.incoming.map(lane => lane.hash), ['main', 'base']);
  assert.deepEqual(main.edges.map(edge => [edge.from, edge.to]), [[0, 0], [1, 0]]);
  assert.deepEqual(base.incoming.map(lane => lane.hash), ['base']);
  assert.deepEqual(base.edges, []);
  const [firstParentMerge] = layoutGraph(commits, [], undefined, true);
  assert.deepEqual(firstParentMerge.edges.map(edge => [edge.from, edge.to]), [[0, 0]]);
  const newerMerge = { hash: 'newer', parents: ['merge', 'hidden'] };
  const [filteredTip, filteredParent] = layoutGraph([newerMerge, commits[0]], [], undefined, false, true);
  assert.deepEqual(filteredTip.edges.map(edge => [edge.from, edge.to]), [[0, 0]]);
  assert.deepEqual(filteredParent.incoming.map(lane => lane.hash), ['merge']);
  assert.deepEqual(filteredParent.edges, []);
});

test('orders merge edges by parent order when a parent already has a lane', () => {
  const commits = [
    { hash: 'tip', parents: ['feature', 'other', 'merge'] },
    { hash: 'merge', parents: ['main', 'feature', 'third'] },
    { hash: 'third', parents: [] },
  ];
  const [, merge, third] = layoutGraph(commits);
  assert.deepEqual(merge.edges.filter(edge => edge.from === merge.column).map(edge => edge.to), [0, 2, 3]);
  assert.deepEqual(merge.edges.filter(edge => edge.from !== merge.column).map(edge => [edge.from, edge.to]), [
    [0, 2], [1, 1],
  ]);
  assert.deepEqual(third.incoming.map(lane => lane.hash), ['main', 'other', 'feature', 'third']);
});

test('remembers branch colors across ref changes and workspace reloads', () => {
  const stored = new Map();
  const storage = {
    get: key => stored.get(key),
    update(key, value) { stored.set(key, value); return Promise.resolve(); },
  };
  const output = { appendLine: assert.fail };
  const main = { group: 'heads', fullName: 'refs/heads/main', hash: 'before' };
  const remote = { group: 'remotes', fullName: 'refs/remotes/origin/main', hash: 'before' };
  const tag = { group: 'tags', fullName: 'refs/tags/v1', hash: 'before' };
  const [coloredMain, coloredRemote, unchangedTag] = new BranchColors(storage, output).decorate('/repo', [
    main, remote, tag,
  ]);
  assert.notEqual(coloredMain.color, coloredRemote.color);
  assert.deepEqual(unchangedTag, tag);

  const reopened = new BranchColors(storage, output);
  const [feature, reloadedRemote, movedMain] = reopened.decorate('/repo', [
    { group: 'heads', fullName: 'refs/heads/feature', hash: 'new' },
    remote,
    { ...main, hash: 'after', current: true },
  ]);
  assert.equal(movedMain.color, coloredMain.color);
  assert.equal(reloadedRemote.color, coloredRemote.color);
  assert.ok(![coloredMain.color, coloredRemote.color].includes(feature.color));
});

test('keeps the named lane color when another branch is filtered or when history is paged', () => {
  const merge = { hash: 'merge', parents: ['main', 'feature'] };
  const feature = { hash: 'feature', parents: ['base'] };
  const main = { hash: 'main', parents: ['base'] };
  const base = { hash: 'base', parents: [] };
  const mainRef = { hash: 'merge', color: '#3b82d6' };
  const featureRef = { hash: 'feature', color: '#dc7431' };

  const [mergeRow, featureRow] = layoutGraph([merge, feature, main, base], [mainRef, featureRef]);
  assert.equal(mergeRow.color, mainRef.color);
  assert.equal(mergeRow.edges[1].color, featureRef.color);
  assert.equal(featureRow.color, featureRef.color);
  assert.equal(layoutGraph([feature, base], [featureRef])[0].color, featureRef.color);
  assert.equal(layoutGraph([merge], [mainRef, featureRef])[0].color, mainRef.color);
  assert.equal(layoutGraph([main, base], [], mainRef.color)[0].color, mainRef.color);
  const append = graphLayout([mainRef, featureRef]);
  assert.deepEqual([...append([merge, feature]), ...append([main, base])],
    layoutGraph([merge, feature, main, base], [mainRef, featureRef]));
});

test('keeps the first-parent line color through older branch tips and up to a shared lane', () => {
  const commits = [
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'feature', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const mainColor = '#3b82d6';
  const featureColor = '#dc7431';
  const refs = [
    { hash: 'merge', color: mainColor },
    { hash: 'main', color: '#1399ab' },
    { hash: 'feature', color: featureColor },
  ];
  const [merge, main, feature, base] = layoutGraph(commits, refs);
  assert.deepEqual(merge.edges.map(edge => edge.color), [mainColor, featureColor]);
  assert.equal(main.color, mainColor);
  assert.equal(feature.edges.find(edge => edge.from === feature.column).color, featureColor);
  assert.equal(base.color, mainColor);
});

test('picks the same lane color when refs at a shared tip are reordered', () => {
  const commits = [{ hash: 'tip', parents: [] }];
  const local = { hash: 'tip', fullName: 'refs/heads/main', color: '#3b82d6' };
  const remote = { hash: 'tip', fullName: 'refs/remotes/origin/main', color: '#dc7431' };
  assert.equal(layoutGraph(commits, [local, remote])[0].color, local.color);
  assert.equal(layoutGraph(commits, [remote, local])[0].color, local.color);
});

test('reuses three palette colors while keeping each lane color across rows and pages', () => {
  const commits = [
    { hash: 'merge', parents: ['main', 'side-a', 'side-b', 'side-c'] },
    { hash: 'side-a', parents: ['side-a-base'] },
    { hash: 'side-a-base', parents: ['main'] },
    { hash: 'side-b', parents: ['main'] },
    { hash: 'side-c', parents: ['main'] },
    { hash: 'main', parents: [] },
  ];
  const append = graphLayout([]);
  const [merge] = append(commits.slice(0, 1));
  const [sideA, sideABase, sideB, sideC, main] = append(commits.slice(1));
  assert.deepEqual(merge.edges.map(edge => edge.paletteIndex), [0, 1, 2, 0]);
  assert.deepEqual([sideA, sideABase, sideB, sideC, main].map(row => row.paletteIndex), [1, 1, 2, 0, 0]);
  assert.equal(sideABase.edges.find(edge => edge.from === sideABase.column).paletteIndex, 1);
});
