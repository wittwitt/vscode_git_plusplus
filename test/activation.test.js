'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { stat } = require('node:fs/promises');
const Module = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { contributes } = require('../package.json');

test('activates with Git CLI when the built-in Git extension has no model', async t => {
  assert.deepEqual(contributes.views.gitPlusPlus.map(view => [view.id, view.type, view.when]), [
    ['gitPlusPlus.refs', 'webview', undefined],
  ]);

  const root = mkdtempSync(join(tmpdir(), 'git-plus-plus-activation-'));
  const subscriptions = [];
  t.after(() => {
    subscriptions.forEach(subscription => subscription.dispose());
    rmSync(root, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'initial.txt'), 'Initial content\n');
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'settings.yaml'), 'enabled: true\n');
  execFileSync('git', ['add', 'initial.txt', 'config/settings.yaml'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=Tester', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
    'commit', '-qm', 'First commit', '--allow-empty',
  ], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const history = Array.from({ length: 200 }, (_, index) => {
    const subject = `Commit ${index + 2}`;
    const content = index === 198 ? 'Intermediate\n' : index === 199 ? 'Updated content\n' : '';
    const change = content ? `M 644 inline initial.txt\ndata ${content.length}\n${content}` : '';
    return `commit refs/heads/main\ncommitter Tester <test@example.invalid> ${1700000000 + index} +0000\n` +
      `data ${subject.length}\n${subject}\n${index === 0 ? `from ${base}\n` : ''}${change}\n`;
  }).join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: history });
  execFileSync('git', ['branch', 'feature/ui', base], { cwd: root });
  execFileSync('git', ['remote', 'add', 'archive', 'archive.git'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'team/review', 'review.git'], { cwd: root });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/feature/ui', 'HEAD'], { cwd: root });
  execFileSync('git', ['update-ref', 'refs/remotes/team/review/main', 'HEAD'], { cwd: root });

  const noop = { dispose() {} };
  const messages = new EventEmitter();
  const commands = new Map();
  const providers = new Map();
  const settings = new Map();
  const log = [];
  const warnings = [];
  const information = [];
  const quickPicks = [];
  const errors = [];
  const openedFiles = [];
  let warningChoice;
  let informationChoice;
  let remoteChoice;
  let sidebarMessage;
  let graphMessage;
  let closeGraph;
  let graphShowOptions;
  let graphVisible = true;
  const graphReveals = [];
  let diffProvider;
  const graphGroup = { viewColumn: 1, tabs: [] };
  let activeGroup = graphGroup;
  let belowGroup;
  let splits = 0;
  const rootUri = { scheme: 'file', fsPath: root };
  const host = {
    Task: class {
      constructor(definition, scope, name, source, execution) {
        this.execution = execution;
      }
    },
    ShellExecution: class {
      constructor(command, options) {
        this.command = command;
        this.options = options;
      }
    },
    TaskRevealKind: { Always: 1 },
    TaskPanelKind: { Shared: 1 },
    extensions: {
      getExtension: () => ({
        isActive: true, exports: { getAPI() { throw new Error('Git model not found'); } },
      }),
    },
    EventEmitter: class {
      constructor() { this.emitter = new EventEmitter(); }
      event = listener => {
        this.emitter.on('change', listener);
        return { dispose: () => this.emitter.off('change', listener) };
      };
      fire(value) { this.emitter.emit('change', value); }
      dispose() { this.emitter.removeAllListeners(); }
    },
    RelativePattern: class {},
    FileType: { File: 1, Directory: 2 },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }), from: value => value, joinPath: join },
    ViewColumn: { Active: -1 },
    workspace: {
      fs: { async stat(uri) {
        const entry = await stat(uri.fsPath);
        return { type: entry.isFile() ? host.FileType.File : host.FileType.Directory };
      } },
      workspaceFolders: [{ uri: rootUri }],
      textDocuments: [],
      getConfiguration: () => ({ get: () => undefined }),
      getWorkspaceFolder: () => ({ uri: rootUri }),
      onDidChangeWorkspaceFolders: () => noop,
      registerTextDocumentContentProvider(scheme, provider) {
        assert.equal(scheme, 'git-plus-plus-diff');
        diffProvider = provider;
        return noop;
      },
      createFileSystemWatcher: () => ({
        ...noop, onDidChange: () => noop, onDidCreate: () => noop, onDidDelete: () => noop,
      }),
    },
    tasks: {
      taskExecutions: [],
      onDidEndTask: () => noop,
      executeTask: async task => { messages.emit('task', task); },
    },
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return noop; },
      async executeCommand(name, ...args) {
        if (name === 'workbench.action.focusBelowGroupWithoutWrap') {
          if (belowGroup) activeGroup = belowGroup;
        } else if (name === 'workbench.action.newGroupBelow') {
          assert.equal(activeGroup, graphGroup);
          activeGroup = belowGroup = { viewColumn: 2, tabs: [] };
          splits++;
        } else if (name === 'vscode.diff') {
          const [original, modified, title, options] = args;
          assert.equal(activeGroup, belowGroup);
          belowGroup.tabs = [...belowGroup.tabs.filter(tab => !tab.isPreview), { input: { original, modified }, isPreview: options.preview }];
          const [before, after] = await Promise.all(args.slice(0, 2).map(uri => diffProvider.provideTextDocumentContent(uri)));
          messages.emit('nativeDiff', { original, modified, title, options, before, after });
        } else if (name === 'vscode.open') {
          openedFiles.push(args);
        } else return commands.get(name)(...args);
      },
    },
    window: {
      async showInformationMessage(message, options, ...actions) {
        information.push({ message, options, actions });
        return informationChoice;
      },
      async showWarningMessage(message, options, ...actions) {
        warnings.push({ message, options, actions });
        return typeof warningChoice === 'function' ? warningChoice(actions) : warningChoice;
      },
      async showQuickPick(items, options) {
        quickPicks.push({ items, options });
        return remoteChoice;
      },
      showErrorMessage(message) { errors.push(message); },
      onDidChangeActiveTextEditor: () => noop,
      createOutputChannel: () => ({ ...noop, appendLine: line => log.push(line) }),
      registerWebviewViewProvider(id, value) { providers.set(id, value); return noop; },
      tabGroups: {
        get activeTabGroup() { return activeGroup; },
        get all() { return belowGroup ? [graphGroup, belowGroup] : [graphGroup]; },
        async close(tabs, preserveFocus) {
          assert.equal(preserveFocus, true);
          belowGroup.tabs = belowGroup.tabs.filter(tab => !tabs.includes(tab));
          if (!belowGroup.tabs.length) {
            belowGroup = undefined;
            activeGroup = graphGroup;
          }
          messages.emit('fileDiffClosed');
          return true;
        },
      },
      async showTextDocument(uri) {
        await diffProvider.provideTextDocumentContent(uri);
      },
      createWebviewPanel(_type, _title, showOptions) {
        graphShowOptions = showOptions;
        return {
          ...noop, onDidDispose(listener) { closeGraph = listener; return noop; }, viewColumn: 1,
          get visible() { return graphVisible; },
          reveal(column, preserveFocus) {
            graphReveals.push({ column, preserveFocus });
            graphVisible = true;
            if (!preserveFocus) activeGroup = graphGroup;
          },
          webview: webview(handler => { graphMessage = handler; }),
        };
      },
    },
  };

  function webview(receive) {
    return {
      cspSource: 'test:',
      asWebviewUri: value => value,
      onDidReceiveMessage(handler) { receive(handler); return noop; },
      postMessage(data) { messages.emit(data.type, structuredClone(data)); },
    };
  }

  function nextMessage(type, action, accept = () => true) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        messages.off(type, receive);
        reject(new Error(`No ${type} message`));
      }, 3000);
      function receive(data) {
        if (!accept(data)) return;
        messages.off(type, receive);
        clearTimeout(timeout);
        resolve(data);
      }
      messages.on(type, receive);
      action();
    });
  }

  const load = Module._load;
  let activate;
  try {
    Module._load = (request, ...args) => request === 'vscode' ? host : load(request, ...args);
    ({ activate } = require('../src/extension'));
  } finally {
    Module._load = load;
  }
  await activate({
    subscriptions,
    extensionUri: join(__dirname, '..'),
    workspaceState: { get: key => settings.get(key), async update(key, value) { settings.set(key, value); } },
  });
  assert.ok(log.some(line => line.includes('Git model not found')));
  const refsWebview = webview(handler => { sidebarMessage = handler; });
  let changeVisibility;
  const refsView = {
    visible: true,
    show() { assert.fail('The visible Git ++ sidebar should switch content without being reopened.'); },
    onDidChangeVisibility(listener) { changeVisibility = listener; return noop; },
    onDidDispose: () => noop,
    webview: refsWebview,
  };
  providers.get('gitPlusPlus.refs').resolveWebviewView(refsView);
  assert.ok(graphMessage, 'Opening the sidebar should show the graph');
  assert.equal(graphShowOptions.preserveFocus, true);
  assert.match(refsWebview.html, /id="toggle-refs"[^>]*aria-expanded="true"/);
  assert.match(refsWebview.html, /id="toggle-files"[^>]*aria-expanded="false"/);
  assert.match(refsWebview.html, /id="commit-files"[^>]* hidden/);
  assert.doesNotMatch(refsWebview.html, /id="back-to-refs"/);
  assert.match(refsWebview.html, /id="diff-list-mode"[^>]*aria-label="List view"[^>]*>\s*<svg/);
  assert.match(refsWebview.html, /id="diff-tree-mode"[^>]*aria-label="Tree view"[^>]*>\s*<svg/);
  const sidebar = await nextMessage('repositories', () => sidebarMessage({ type: 'ready' }));
  const repositoryRoot = sidebar.repositories[0].root;
  const fetchTask = await nextMessage('task', () => sidebarMessage({
    type: 'fetch', root: repositoryRoot,
  }));
  assert.equal(fetchTask.execution.command, 'git fetch --all --tags');
  assert.equal(fetchTask.execution.options.cwd, repositoryRoot);
  assert.equal(sidebar.repositories.length, 1);
  assert.deepEqual(sidebar.repositories[0].checkedBranches, ['refs/heads/main']);
  const [localGroup, archiveGroup, originGroup, reviewGroup] = sidebar.repositories[0].groups;
  assert.deepEqual(sidebar.repositories[0].groups.map(group => group.label), [
    'local', 'remote/archive', 'remote/origin', 'remote/team/review', 'tags',
  ]);
  assert.deepEqual(localGroup.children.map(node => node.label), ['main', 'feature']);
  assert.equal(localGroup.children[1].children[0].label, 'ui');
  assert.equal(localGroup.children[1].children[0].ref.fullName, 'refs/heads/feature/ui');
  assert.deepEqual(archiveGroup.children, []);
  assert.equal(originGroup.children[0].label, 'feature');
  assert.equal(originGroup.children[0].children[0].label, 'ui');
  assert.equal(reviewGroup.children[0].label, 'main');
  const revealBranch = fullName => sidebarMessage({
    type: 'revealRef', root: sidebar.repositories[0].root, fullName,
  });
  revealBranch('refs/heads/feature/ui');
  assert.deepEqual(graphReveals, []);
  const graph = await nextMessage('history', () => graphMessage({ type: 'ready' }));
  const allRefNames = [
    'refs/heads/feature/ui', 'refs/heads/main', 'refs/remotes/origin/feature/ui', 'refs/remotes/team/review/main',
  ];
  assert.deepEqual(graph.refs.map(ref => ref.fullName).sort(), allRefNames);
  assert.equal(graph.commits[0].subject, 'Commit 201');
  assert.equal(graph.commits.length, 200);
  assert.equal(graph.hasMore, true);
  refsView.visible = false;
  graphVisible = false;
  changeVisibility();
  assert.deepEqual(graphReveals, []);
  refsView.visible = true;
  changeVisibility();
  assert.deepEqual(graphReveals, [{ column: undefined, preserveFocus: true }]);
  const newer = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: 'COMMIT 20', request: 1, page: graph.page,
  }));
  assert.equal(newer.hash, graph.commits[0].hash);
  const following = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: 'COMMIT 20', request: 2, page: graph.page, after: newer.hash,
  }));
  assert.equal(following.hash, graph.commits[1].hash);
  const lastMatch = graph.commits.find(commit => commit.subject === 'Commit 20');
  const wrapped = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: 'COMMIT 20', request: 3, page: graph.page, after: lastMatch.hash,
  }));
  assert.equal(wrapped.hash, newer.hash);
  const nextBatch = await nextMessage('history', () => {
    graphMessage({ type: 'more', page: graph.page });
    graphMessage({ type: 'more', page: graph.page });
  });
  assert.equal(nextBatch.offset, graph.commits.length);
  assert.equal(nextBatch.commits.length, 1);
  assert.equal(nextBatch.refs, undefined);
  const nextPage = { ...graph, ...nextBatch, commits: [...graph.commits, ...nextBatch.commits] };
  assert.equal(nextPage.page, graph.page + 1);
  assert.equal(nextPage.commits.length, 201);
  assert.equal(nextPage.commits.at(-1).subject, 'First commit');
  assert.deepEqual(nextPage.refs.filter(ref => ref.hash === base).map(ref => ref.name), ['feature/ui']);
  assert.equal(nextPage.hasMore, false);
  const selectCommit = (hash, compareWith) => nextMessage('commitFiles',
    () => graphMessage({ type: 'previewDiff', hash, compareWith }),
    data => Boolean(data.commit?.files));
  const { commit: files } = await selectCommit(base);
  assert.deepEqual(files.files.map(file => [file.path, file.status]), [['config/settings.yaml', 'A'], ['initial.txt', 'A']]);
  const openFile = (index, request = files.request) => nextMessage('nativeDiff',
    () => sidebarMessage({ type: 'openFileDiff', index, request }));
  const diff = await openFile(1);
  assert.equal(diff.before, '');
  assert.equal(diff.after, 'Initial content\n');
  assert.equal(diff.options.viewColumn, 2);
  assert.equal(diff.options.preview, true);
  await sidebarMessage({ type: 'changedFilesMode', mode: 'tree' });
  assert.equal(settings.get('gitPlusPlus.diffFileMode'), 'tree');
  await sidebarMessage({ type: 'openWorkingFile', index: 0, request: files.request });
  assert.deepEqual(openedFiles, [[host.Uri.file(join(repositoryRoot, 'config', 'settings.yaml')), { preview: false }]]);
  const yaml = await openFile(0);
  assert.equal(yaml.after, 'enabled: true\n');
  assert.equal(yaml.modified.path, '/config/settings.yaml');
  assert.equal(splits, 1);
  const newest = nextPage.commits[0];
  const { commit: comparison } = await selectCommit(base, newest.hash);
  assert.equal(comparison.baseShortHash, nextPage.commits.at(-1).shortHash);
  assert.equal(comparison.shortHash, newest.shortHash);
  assert.deepEqual(comparison.files, [{ path: 'initial.txt', status: 'M' }]);
  const endpoints = await openFile(0, comparison.request);
  assert.equal(endpoints.before, 'Initial content\n');
  assert.equal(endpoints.after, 'Updated content\n');
  assert.match(endpoints.title, / → /);
  const oldDiffClosed = nextMessage('fileDiffClosed', () => {});
  const { commit: emptyCommit } = await selectCommit(graph.commits[2].hash);
  await oldDiffClosed;
  assert.deepEqual(emptyCommit.files, []);
  await sidebarMessage({ type: 'openFileDiff', index: 0, request: files.request });
  await sidebarMessage({ type: 'openWorkingFile', index: 0, request: files.request });
  assert.equal(openedFiles.length, 1);
  assert.equal(belowGroup, undefined);

  const { commit: selected } = await selectCommit(base);
  await openFile(1, selected.request);
  const unrelatedTab = { input: { uri: host.Uri.file(join(root, 'initial.txt')) } };
  belowGroup.tabs.push(unrelatedTab);
  const currentDiffClosed = nextMessage('fileDiffClosed', () => {});
  const closed = await nextMessage('commitFiles', () => graphMessage({ type: 'cancelDiff', closeFileDiff: true }));
  await currentDiffClosed;
  assert.equal(closed.commit, undefined);
  assert.deepEqual(belowGroup.tabs, [unrelatedTab]);
  assert.equal(await diffProvider.provideTextDocumentContent(yaml.modified), 'enabled: true\n');

  const restoredPatch = await diffProvider.provideTextDocumentContent(host.Uri.from({
    scheme: 'git-plus-plus-diff', path: `/${nextPage.commits.at(-1).shortHash}.diff`,
    query: JSON.stringify({ root: repositoryRoot, hash: base }),
  }));
  assert.match(restoredPatch, /\+Initial content/);
  assert.match(restoredPatch, /\+enabled: true/);
  messages.once('loading', () => assert.fail('Pagination should stop at the end'));
  graphMessage({ type: 'more', page: nextPage.page });
  messages.removeAllListeners('loading');
  const selectGroup = (group, checked) => sidebarMessage({
    type: 'filterBranchGroup', root: sidebar.repositories[0].root, group, checked,
  });
  const allLocal = await nextMessage('history', () => selectGroup('heads', true));
  assert.deepEqual(allLocal.refs.map(ref => ref.fullName), allRefNames);
  assert.equal(allLocal.commits.length, 200);
  const reached = await nextMessage('history', () => revealBranch('refs/heads/feature/ui'));
  assert.equal(reached.selected, undefined);
  assert.equal(reached.revealHash, base);
  assert.equal(reached.scope, undefined);
  assert.equal(reached.commits[0].subject, 'Commit 201');
  assert.equal(reached.commits.at(-1).hash, base);
  const originSelection = nextMessage('branchSelection', () => {});
  await nextMessage('history', () => selectGroup(originGroup.id, true));
  assert.deepEqual((await originSelection).checkedBranches, allRefNames.slice(0, 3));
  const allBranches = await nextMessage('history', () => selectGroup(reviewGroup.id, true));
  assert.equal(allBranches.refs.length, 4);
  let expanded;
  const older = await nextMessage('searchResult', () => {
    messages.once('history', data => { expanded = data; });
    graphMessage({ type: 'search', query: base, request: 4, page: allBranches.page });
  });
  assert.equal(older.hash, base);
  assert.equal(expanded.commits.at(-1).hash, base);
  assert.equal(expanded.offset, allBranches.commits.length);
  const remoteOnly = await nextMessage('history', () => selectGroup('heads', false));
  assert.deepEqual(remoteOnly.refs.map(ref => ref.fullName).sort(), allRefNames);
  const reviewOnly = await nextMessage('history', () => selectGroup(originGroup.id, false));
  assert.equal(reviewOnly.refs[0].fullName, 'refs/remotes/team/review/main');
  const noBranches = await nextMessage('history', () => selectGroup(reviewGroup.id, false));
  assert.deepEqual(noBranches.commits, []);

  function git(...args) {
    execFileSync('git', [
      '-c', 'user.name=Tester', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: root });
  }
  git('checkout', '-q', '-b', 'unmerged', base);
  git('commit', '--allow-empty', '-qm', 'Unmerged commit');
  git('checkout', '-q', '-b', 'side', base);
  git('commit', '--allow-empty', '-qm', 'Merged side commit');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', 'side', '-m', 'Merge side');
  git('update-ref', 'refs/remotes/team/review/main', 'HEAD');
  const merged = await nextMessage('history', () => selectGroup(reviewGroup.id, true));
  assert.equal(merged.firstParent, false);
  assert.deepEqual(settings.get(`gitPlusPlus.branches:${repositoryRoot}`), ['refs/remotes/team/review/main']);
  const mergedSide = merged.commits.find(commit => commit.subject === 'Merged side commit');
  assert.ok(mergedSide);
  assert.deepEqual(merged.refs.filter(ref => ref.hash === mergedSide.hash).map(ref => ref.name), ['side']);
  assert.equal(merged.commits.some(commit => commit.subject === 'Unmerged commit'), false);
  const firstParent = await nextMessage('history', () => graphMessage({
    type: 'firstParent', checked: true, commitContext: merged.commitContext,
  }));
  assert.equal(firstParent.firstParent, true);
  assert.equal(settings.get(`gitPlusPlus.firstParent:${repositoryRoot}`), true);
  assert.equal(firstParent.resetScroll, true);
  assert.equal(firstParent.commits[0].subject, 'Merge side');
  const hidden = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: 'Merged side commit', request: 5, page: firstParent.page,
  }));
  assert.equal(hidden.hash, undefined);
  const olderFirstParent = nextMessage('history', () => {}, data => data.page === firstParent.page);
  const foundBase = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: base, request: 6, page: firstParent.page,
  }));
  assert.equal(foundBase.hash, base);
  assert.equal((await olderFirstParent).commits.length, 2);
  const merges = await nextMessage('history', () => graphMessage({
    type: 'mergesOnly', checked: true, commitContext: firstParent.commitContext,
  }));
  assert.equal(merges.firstParent, true);
  assert.equal(merges.mergesOnly, true);
  assert.equal(merges.resetScroll, true);
  assert.deepEqual(merges.commits.map(commit => commit.subject), ['Merge side']);
  const excluded = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: base, request: 9, page: merges.page,
  }));
  assert.equal(excluded.hash, undefined);
  const foundMerge = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: 'Merge side', request: 10, page: merges.page,
  }));
  assert.equal(foundMerge.hash, merges.commits[0].hash);
  closeGraph();
  await commands.get('gitPlusPlus.openGraph')({ webviewSection: 'repository', root: repositoryRoot });
  const checkbox = nextMessage('firstParent', () => {});
  const mergesCheckbox = nextMessage('mergesOnly', () => {});
  const reopened = await nextMessage('history', () => graphMessage({ type: 'ready' }));
  assert.equal(reopened.firstParent, true);
  assert.deepEqual(await checkbox, { type: 'firstParent', checked: true, commitContext: reopened.commitContext });
  assert.deepEqual(await mergesCheckbox, { type: 'mergesOnly', checked: true, commitContext: reopened.commitContext });
  assert.equal(settings.get(`gitPlusPlus.mergesOnly:${repositoryRoot}`), true);
  assert.deepEqual(reopened.refs, firstParent.refs);
  const allCommits = await nextMessage('history', () => graphMessage({
    type: 'mergesOnly', checked: false, commitContext: reopened.commitContext,
  }));
  assert.equal(allCommits.firstParent, true);
  assert.equal(allCommits.mergesOnly, false);
  assert.equal(allCommits.commits.length, 200);
  const restored = await nextMessage('history', () => graphMessage({
    type: 'firstParent', checked: false, commitContext: reopened.commitContext,
  }));
  assert.equal(settings.get(`gitPlusPlus.firstParent:${repositoryRoot}`), false);
  const visible = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: 'Merged side commit', request: 7, page: restored.page,
  }));
  assert.equal(visible.hash, restored.commits[0].parents[1]);

  const branchContext = fullName => ({ webviewSection: 'localBranch', root: repositoryRoot, fullName });
  const switchBranch = commands.get('gitPlusPlus.switchBranch');
  const deleteBranch = commands.get('gitPlusPlus.deleteBranch');
  const currentBranch = () => execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  const localBranches = () => execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const feature = branchContext('refs/heads/feature/ui');
  const main = branchContext('refs/heads/main');
  function refreshAfter(action) {
    return Promise.all([nextMessage('history', () => {}), nextMessage('repositories', action)]);
  }
  const [, switched] = await refreshAfter(() => switchBranch(feature));
  assert.equal(currentBranch(), 'feature/ui');
  assert.equal(switched.repositories[0].groups[0].children
    .find(node => node.label === 'feature').children[0].ref.current, true);
  await deleteBranch(feature);
  await deleteBranch(branchContext('refs/remotes/origin/feature/ui'));
  assert.deepEqual(warnings, []);

  await deleteBranch(main);
  assert.deepEqual(warnings[0], {
    message: 'Delete local branch "main"?', options: { modal: true }, actions: ['Delete Branch'],
  });
  assert.ok(localBranches().includes('main'));
  warningChoice = 'Delete Branch';
  await deleteBranch(main);
  assert.equal(warnings.at(-1).message, 'Force delete local branch "main"?');
  assert.equal(warnings.at(-1).options.modal, true);
  assert.deepEqual(warnings.at(-1).actions, ['Force Delete Branch']);
  assert.equal(errors.length, 0);
  assert.ok(localBranches().includes('main'));

  await refreshAfter(() => switchBranch(main));
  await refreshAfter(() => deleteBranch(feature));
  assert.equal(currentBranch(), 'main');
  assert.ok(!localBranches().includes('feature/ui'));

  const worktree = join(root, 'linked-worktree');
  git('worktree', 'add', '-q', worktree, 'side');
  const warningCount = warnings.length;
  await deleteBranch(branchContext('refs/heads/side'));
  assert.equal(warnings.length, warningCount + 1);
  assert.match(errors.at(-1), /^Could not delete "side":/);
  assert.ok(localBranches().includes('side'));
  git('worktree', 'remove', worktree);

  git('config', 'advice.forceDeleteBranch', 'false');
  warningChoice = actions => actions[0];
  const unmergedBranch = branchContext('refs/heads/unmerged');
  const [refreshed, afterForceDelete] = await refreshAfter(() => deleteBranch(unmergedBranch));
  assert.equal(warnings.at(-1).message, 'Force delete local branch "unmerged"?');
  assert.ok(!localBranches().includes('unmerged'));
  assert.ok(!afterForceDelete.repositories[0].groups[0].children.some(node => node.label === 'unmerged'));

  const commitMenus = contributes.menus['webview/context'].filter(item => item.when.includes('gitPlusPlus.graph'));
  assert.deepEqual(commitMenus.map(({ command, group }) => [command, group]), [
    ['gitPlusPlus.createCommitBranch', '1_refs@1'],
    ['gitPlusPlus.addCommitTag', '1_refs@2'],
    ['gitPlusPlus.checkoutCommit', '2_worktree@1'],
    ['gitPlusPlus.revertCommit', '2_worktree@2'],
    ['gitPlusPlus.cherryPickCommit', '2_worktree@3'],
  ]);
  const commitContext = (hash, context = restored.commitContext) => ({ webviewSection: 'commit', commitContext: context, hash });
  const showAction = (command, hash) => nextMessage('showCommitAction',
    () => commands.get(`gitPlusPlus.${command}`)(commitContext(hash)));
  const submitAction = ({ request }, options) => graphMessage({ type: 'submitCommitAction', request, options });
  const applyAction = (action, options) => Promise.all([
    nextMessage('closeCommitAction', () => {}, data => data.request === action.request),
    refreshAfter(() => submitAction(action, options)),
  ]);
  const revisionAt = ref => execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
  const merge = restored.commits[0];
  const loadedBase = await nextMessage('searchResult', () => graphMessage({
    type: 'search', query: base, request: 8, page: refreshed.page,
  }));
  assert.equal(loadedBase.hash, base);
  const cancelled = await showAction('createCommitBranch', base);
  graphMessage({ type: 'cancelCommitAction', request: cancelled.request });
  await submitAction(cancelled, { name: 'cancelled' });
  assert.ok(!localBranches().includes('cancelled'));
  messages.once('showCommitAction', () => assert.fail('An outdated context must not open a commit action'));
  commands.get('gitPlusPlus.createCommitBranch')(commitContext(base, 'outdated'));
  messages.removeAllListeners('showCommitAction');

  await applyAction(await showAction('createCommitBranch', base), { name: 'from-graph' });
  assert.equal(revisionAt('from-graph'), base);
  assert.equal(currentBranch(), 'main');
  const branchAction = await showAction('createCommitBranch', base);
  const invalid = await nextMessage('commitActionError', () => submitAction(branchAction, { name: 'bad branch' }));
  assert.equal(invalid.request, branchAction.request);
  await applyAction(branchAction, { name: 'graph-checkout', checkout: true });
  assert.equal(currentBranch(), 'graph-checkout');
  assert.equal(revisionAt('HEAD'), base);

  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'tag.gpgSign', 'true');
  await applyAction(await showAction('addCommitTag', merge.hash), { name: 'graph-lightweight', tagType: 'lightweight' });
  assert.equal(revisionAt('graph-lightweight'), merge.hash);
  const tagOptions = { name: 'graph-annotated', tagType: 'annotated', tagMessage: 'Release notes\n\nSecond paragraph' };
  await applyAction(await showAction('addCommitTag', merge.hash), tagOptions);
  assert.equal(revisionAt('graph-annotated^{commit}'), merge.hash);
  assert.match(execFileSync('git', ['cat-file', '-p', 'graph-annotated'], { cwd: root, encoding: 'utf8' }),
    /Release notes\n\nSecond paragraph/);

  await applyAction(await showAction('checkoutCommit', merge.hash), { merge: true });
  assert.equal(currentBranch(), '');
  assert.equal(revisionAt('HEAD'), merge.hash);
  await applyAction(await showAction('checkoutCommit', merge.parents[1]), { name: 'graph-side', submodules: true });
  assert.equal(currentBranch(), 'graph-side');
  assert.equal(revisionAt('HEAD'), merge.parents[1]);
  const cherryPick = await showAction('cherryPickCommit', merge.hash);
  assert.deepEqual(cherryPick.commit.parents, merge.parents);
  const parentError = await nextMessage('commitActionError', () => submitAction(cherryPick, { mainline: 0 }));
  assert.equal(parentError.message, 'Select a mainline parent.');
  await applyAction(cherryPick, { mainline: 2 });
  assert.equal(execFileSync('git', ['show', 'HEAD:initial.txt'], { cwd: root, encoding: 'utf8' }), 'Updated content\n');
  await applyAction(await showAction('revertCommit', newest.hash), {});
  assert.equal(execFileSync('git', ['show', 'HEAD:initial.txt'], { cwd: root, encoding: 'utf8' }), 'Intermediate\n');

  git('init', '-q', '--bare', 'archive.git');
  git('init', '-q', '--bare', 'review.git');
  const remoteRef = 'refs/heads/upstream/topic';
  const trackingRef = 'refs/remotes/archive/work/topic';
  git('config', 'remote.archive.fetch', `+${remoteRef}:${trackingRef}`);
  git('push', '-q', 'archive', `refs/heads/main:${remoteRef}`);
  const refreshCommand = commands.get('gitPlusPlus.refresh');
  const cachedTags = nextMessage('localOnlyTags', () => {}, data => data.names.includes('refs/tags/graph-lightweight'));
  await refreshAfter(refreshCommand);
  assert.ok((await cachedTags).names.includes('refs/tags/graph-annotated'));
  git('push', '-q', 'archive', 'refs/tags/graph-lightweight', 'refs/tags/graph-annotated');

  const remoteContext = { webviewSection: 'remoteBranch', root: repositoryRoot, fullName: trackingRef };
  const switchRemote = () => commands.get('gitPlusPlus.switchRemoteBranch')(remoteContext);
  const [, cachedSidebar] = await refreshAfter(switchRemote);
  assert.ok(cachedSidebar.repositories[0].localOnlyTags.includes('refs/tags/graph-lightweight'));
  const updatedTags = nextMessage('localOnlyTags', () => {}, data => !data.names.includes('refs/tags/graph-lightweight'));
  await refreshAfter(refreshCommand);
  assert.ok(!(await updatedTags).names.includes('refs/tags/graph-annotated'));
  assert.equal(currentBranch(), 'work/topic');
  assert.equal(revisionAt('@{upstream}'), revisionAt(trackingRef));

  await refreshAfter(() => switchBranch(main));
  await refreshAfter(switchRemote);
  assert.equal(currentBranch(), 'work/topic');
  const syncBranch = (operation, context) => commands.get(`gitPlusPlus.${operation}Branch`)(context);
  const remoteHead = () => execFileSync('git', ['ls-remote', 'archive', remoteRef],
    { cwd: root, encoding: 'utf8' }).split('\t')[0];
  const localTracking = branchContext('refs/heads/work/topic');
  git('commit', '--allow-empty', '-qm', 'Push a commit from a local branch menu');
  await refreshAfter(() => switchBranch(main));
  await refreshAfter(() => syncBranch('push', localTracking));
  assert.equal(currentBranch(), 'main');
  assert.equal(remoteHead(), revisionAt('work/topic'));

  await refreshAfter(switchRemote);
  git('commit', '--allow-empty', '-qm', 'Push a commit from a remote branch menu');
  await refreshAfter(() => switchBranch(main));
  await refreshAfter(() => syncBranch('push', remoteContext));
  assert.equal(currentBranch(), 'main');
  const pushed = revisionAt('work/topic');
  assert.equal(remoteHead(), pushed);

  git('branch', '-f', 'work/topic', `${pushed}^`);
  await syncBranch('pull', remoteContext);
  assert.equal(currentBranch(), 'main');
  assert.deepEqual(information.at(-1).actions, ['Switch and Pull']);
  informationChoice = 'Switch and Pull';
  await refreshAfter(() => syncBranch('pull', remoteContext));
  assert.equal(currentBranch(), 'work/topic');
  assert.equal(revisionAt('HEAD'), pushed);

  git('reset', '--keep', `${pushed}^`);
  await refreshAfter(() => syncBranch('pull', localTracking));
  assert.equal(revisionAt('HEAD'), pushed);

  const deleteRemote = () => commands.get('gitPlusPlus.deleteRemoteBranch')(remoteContext);
  const remoteHasRef = ref => Boolean(execFileSync('git', ['ls-remote', 'archive', ref], { cwd: root, encoding: 'utf8' }).trim());
  warningChoice = undefined;
  await deleteRemote();
  assert.equal(remoteHasRef(remoteRef), true);
  assert.match(warnings.at(-1).message, /"upstream\/topic".*"archive"/);
  warningChoice = 'Delete Remote Branch';
  const [, afterDeletion] = await refreshAfter(deleteRemote);
  assert.equal(remoteHasRef(remoteRef), false);
  assert.deepEqual(afterDeletion.repositories[0].groups.find(group => group.id === 'remotes/archive').children, []);
  assert.equal(currentBranch(), 'work/topic');

  const deleteTag = fullName => commands.get('gitPlusPlus.deleteTag')({ webviewSection: 'tag', root: repositoryRoot, fullName });
  const lightweightTag = 'refs/tags/graph-lightweight';
  const annotatedTag = 'refs/tags/graph-annotated';
  warningChoice = 'Delete Locally';
  await refreshAfter(() => deleteTag(lightweightTag));
  assert.deepEqual(warnings.at(-1).actions, ['Delete Locally', 'Delete Locally and Remotely']);
  assert.equal(remoteHasRef(lightweightTag), true);
  assert.equal(execFileSync('git', ['tag', '--list', 'graph-lightweight'], { cwd: root, encoding: 'utf8' }), '');

  warningChoice = 'Delete Locally and Remotely';
  remoteChoice = 'team/review';
  git('remote', 'set-url', 'team/review', 'missing-review.git');
  await deleteTag(annotatedTag);
  assert.match(errors.at(-1), /^Could not delete tag "graph-annotated":/);
  assert.equal(revisionAt(`${annotatedTag}^{commit}`), merge.hash);
  remoteChoice = 'archive';
  await refreshAfter(() => deleteTag(annotatedTag));
  assert.deepEqual(quickPicks.at(-1).items, ['archive', 'team/review']);
  assert.equal(remoteHasRef(annotatedTag), false);
  assert.equal(execFileSync('git', ['tag', '--list', 'graph-annotated'], { cwd: root, encoding: 'utf8' }), '');
});
