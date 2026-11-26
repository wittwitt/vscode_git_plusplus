'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { basename, join } = require('node:path');
const {
  pageSize, readRefs, openHistory, readCommitDiff, readCommitFiles, readCommitFileDiff,
  readCommitFileComparison, readCommitFileVersion,
  findHistoryMatch, resolveCommit, readBranchTipsContaining, applyCommitAction,
} = require('./git');
const { BranchFilter } = require('./branchFilter');
const { BranchColors } = require('./branchColors');
const { openGit } = require('./gitRepositories');
const { SidebarView, viewId, taskType, selectRepository } = require('./sidebar');

const diffScheme = 'git-plus-plus-diff';
const emptyDiff = 'No file changes in this commit.';
const commitActions = {
  createCommitBranch: 'branch',
  addCommitTag: 'tag',
  checkoutCommit: 'checkout',
  revertCommit: 'revert',
  cherryPickCommit: 'cherryPick',
};

function isFileDiff(tab) {
  const resource = tab.input?.modified ?? tab.input?.uri;
  return resource?.scheme === diffScheme && resource.fragment === 'file-diff';
}

function fileDiffKey(uri) {
  return `${uri.path}\0${uri.query}`;
}

class GraphView {
  constructor(extensionUri, git, output, branchFilter, branchColors, sidebar, storage, refreshRepository) {
    this.extensionUri = extensionUri;
    this.git = git;
    this.output = output;
    this.branchFilter = branchFilter;
    this.branchColors = branchColors;
    this.sidebar = sidebar;
    this.storage = storage;
    this.refreshRepository = refreshRepository;
    this.generation = 0;
    this.diffRequest = 0;
    this.commitActionRequest = 0;
    this.fileContents = new Map();
    this.firstParentByRoot = new Map();
    this.mergesOnlyByRoot = new Map();
  }

  show(root) {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(undefined, true);
    } else if (root) {
      this.open(root, undefined, true);
    }
  }

  open(root, fullName, preserveFocus = Boolean(fullName)) {
    const rootChanged = this.root !== root;
    if (rootChanged) {
      this.firstParent = (this.firstParentByRoot.get(root) ?? this.storage.get(`gitPlusPlus.firstParent:${root}`)) === true;
      this.mergesOnly = (this.mergesOnlyByRoot.get(root) ?? this.storage.get(`gitPlusPlus.mergesOnly:${root}`)) === true;
    }
    if (!this.panel || rootChanged) {
      this.commitContext = randomBytes(18).toString('hex');
      if (this.commitAction) {
        void this.panel?.webview.postMessage({ type: 'closeCommitAction', request: this.commitAction.request });
        this.commitAction = undefined;
      }
      this.clearDiff();
    }
    this.resetHistory = !this.panel || rootChanged;
    if (!this.panel || rootChanged || !fullName) this.limit = pageSize;
    this.root = root;
    this.fullName = fullName;
    this.scoped = false;
    this.reveal = Boolean(fullName);
    if (!this.panel) {
      this.ready = false;
      const media = vscode.Uri.joinPath(this.extensionUri, 'media');
      const panel = vscode.window.createWebviewPanel(
        'gitPlusPlus.graph', 'Git ++ Commit Graph', { viewColumn: vscode.ViewColumn.Active, preserveFocus },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
      );
      this.panel = panel;
      const receiver = panel.webview.onDidReceiveMessage(message => {
        switch (message?.type) {
          case 'ready':
            this.ready = true;
            this.syncHistoryFilters();
            this.load();
            break;
          case 'firstParent':
          case 'mergesOnly': {
            const { type, checked, commitContext } = message;
            if (commitContext !== this.commitContext || typeof checked !== 'boolean') break;
            if (checked === this[type]) break;
            this[type] = checked;
            const { root } = this;
            const byRoot = type === 'firstParent' ? this.firstParentByRoot : this.mergesOnlyByRoot;
            byRoot.set(root, checked);
            void this.storage.update(`gitPlusPlus.${type}:${root}`, checked).then(undefined, error => {
              this.output.appendLine(`${root}: Could not save the history filter: ${error.message}`);
            });
            this.limit = pageSize;
            this.resetHistory = true;
            this.scoped = false;
            this.reveal = false;
            this.load();
            break;
          }
          case 'more':
            if (this.hasMore && message.page === this.generation) void this.loadMore();
            break;
          case 'all':
            this.filterChanged(this.root);
            break;
          case 'refresh':
            this.load();
            break;
          case 'search':
            void this.search(message);
            break;
          case 'cancelSearch':
            this.searchController?.abort();
            break;
          case 'previewDiff':
            this.previewDiff(message);
            break;
          case 'cancelDiff':
            this.clearDiff();
            if (message.closeFileDiff === true) this.closeFileDiff();
            break;
          case 'submitCommitAction':
            return this.runCommitAction(message);
          case 'cancelCommitAction':
            if (this.commitAction?.request === message.request && !this.commitAction.running) {
              this.commitAction = undefined;
            }
            break;
        }
      });
      panel.onDidDispose(() => {
        this.refCheck?.abort();
        this.searchController?.abort();
        this.stopHistory();
        this.clearDiff();
        this.snapshot = undefined;
        this.commitAction = undefined;
        receiver.dispose();
        this.panel = undefined;
        this.ready = false;
        this.generation++;
      });
      panel.webview.html = webviewHtml(panel.webview, media);
    } else {
      this.panel.reveal(undefined, preserveFocus);
      if (rootChanged && this.ready) this.syncHistoryFilters();
    }
    this.panel.title = `Git ++ · ${basename(root)}`;
    this.load();
  }

  syncHistoryFilters() {
    for (const type of ['firstParent', 'mergesOnly']) {
      void this.panel.webview.postMessage({ type, checked: this[type], commitContext: this.commitContext });
    }
  }

  filterChanged(root) {
    if (!this.panel || this.root !== root) return;
    this.fullName = undefined;
    this.scoped = false;
    this.reveal = false;
    this.limit = pageSize;
    this.resetHistory = true;
    void this.load();
  }

  stopHistory() {
    this.historyController?.abort();
    this.history?.close();
    this.historyController = undefined;
    this.history = undefined;
  }

  refreshIfChanged(refsPromise) {
    if (!this.panel || !this.ready) return;
    if (!this.snapshot) {
      void this.load(refsPromise);
      return;
    }
    this.refCheck?.abort();
    const check = new AbortController();
    this.refCheck = check;
    const pending = refsPromise ?? readRefs(this.root, this.git.path, check.signal);
    void pending.then(refs => {
      if (!check.signal.aborted && this.snapshot?.refsKey !== JSON.stringify(refs)) void this.load(pending);
    }, error => {
      if (!check.signal.aborted && error.name !== 'AbortError') void this.load(pending);
    }).finally(() => {
      if (this.refCheck === check) this.refCheck = undefined;
    });
  }

  async load(refsPromise) {
    if (!this.panel || !this.ready) return;
    const { panel, root, fullName, limit, reveal, resetHistory, firstParent, mergesOnly, scoped: wasScoped } = this;
    const gitPath = this.git.path;
    const generation = ++this.generation;
    this.refCheck?.abort();
    this.searchController?.abort();
    this.stopHistory();
    const controller = new AbortController();
    this.historyController = controller;
    const historyOptions = { firstParent, mergesOnly, signal: controller.signal };
    const open = start => {
      this.history = openHistory(root, gitPath, start, historyOptions);
      return this.history.read(limit);
    };
    this.hasMore = false;
    const post = message => {
      if (generation === this.generation) void panel.webview.postMessage(message);
    };
    post({ type: 'loading', resetHistory });
    try {
      const read = () => readRefs(root, gitPath, controller.signal);
      const rawRefs = await (refsPromise ? refsPromise.catch(error => {
        if (error.name === 'AbortError' && !controller.signal.aborted) return read();
        throw error;
      }) : read());
      if (generation !== this.generation) return;
      const refs = this.branchColors.decorate(root, rawRefs);
      const branches = this.branchFilter.selected(root, refs);
      const tips = [...new Set(branches.map(ref => ref.hash).filter(Boolean))];
      const [initial, selection] = await Promise.all([
        wasScoped ? undefined : open(tips),
        this.resolveSelection(root, fullName, refs, branches, controller.signal),
      ]);
      if (generation !== this.generation) return;
      let { hash, warning } = selection;
      let history = initial;
      let historyLimit = limit;
      let scopedBranch;
      if (selection.branch && hash) {
        while (reveal && history?.hasMore && !history.commits.some(commit => commit.hash === hash)) {
          historyLimit *= 2;
          history = await this.history.read(historyLimit);
          if (generation !== this.generation) return;
        }
        if (!history?.commits.some(commit => commit.hash === hash)) hash = undefined;
      } else if (hash && !initial?.commits.some(commit => commit.hash === hash)) {
        scopedBranch = branches.find(ref => ref.hash === hash);
        if (!scopedBranch && tips.length && (firstParent || mergesOnly || wasScoped || initial?.hasMore)) {
          const containing = await readBranchTipsContaining(root, gitPath, hash, controller.signal);
          scopedBranch = branches.find(ref => containing.has(ref.hash));
        }
        if (!scopedBranch) {
          warning = 'This commit is outside the selected branches.';
          hash = undefined;
        }
      }
      if (generation !== this.generation) return;
      const scoped = Boolean(scopedBranch);
      if (scoped || !history) {
        this.history?.close();
        history = await open(scoped ? hash : tips);
      }
      if (generation !== this.generation) return;
      const scope = scoped ? selection.label : undefined;
      const visibleHash = mergesOnly && !history.commits.some(commit => commit.hash === hash) ? undefined : hash;
      const selectedBranches = new Set(branches);
      this.hasMore = history.hasMore;
      const data = {
        type: 'history', page: generation, commitContext: this.commitContext, ...historyOptions, ...history,
        refs: [...branches, ...refs.filter(ref => !selectedBranches.has(ref))],
        selected: selection.branch ? undefined : visibleHash,
        revealHash: reveal ? visibleHash : undefined, warning, scope, scopeColor: scopedBranch?.color,
        emptyMessage: mergesOnly && tips.length ? 'No merge commits in this history.'
          : refs.some(ref => ref.group !== 'tags') ? 'Select branches in the sidebar to show their history.'
            : 'This repository has no branches.',
        resetScroll: resetHistory || this.lastRoot !== root || this.lastScope !== scope,
      };
      this.snapshot = { root, tips: scoped ? [hash] : tips, refsKey: JSON.stringify(rawRefs), data };
      post(data);
      this.scoped = scoped;
      this.limit = historyLimit;
      this.reveal = false;
      this.resetHistory = false;
      this.lastRoot = root;
      this.lastScope = scope;
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopHistory();
      this.snapshot = undefined;
      this.output.appendLine(`${root}: ${error.message}`);
      post({ type: 'error', message: 'Could not read commit history. See Git ++ in the Output panel for details.' });
    }
  }

  async appendHistory(snapshot, limit, page, current) {
    const { commits } = snapshot.data;
    const offset = commits.length;
    const batch = await this.history.read(limit, offset);
    if (!current()) return;
    for (const commit of batch.commits) commits.push(commit);
    this.limit = limit;
    this.hasMore = batch.hasMore;
    snapshot.data.page = page;
    snapshot.data.hasMore = batch.hasMore;
    await this.panel.webview.postMessage({
      type: 'history', page, offset, ...batch,
      firstParent: snapshot.data.firstParent, mergesOnly: snapshot.data.mergesOnly,
    });
  }

  async loadMore() {
    const { snapshot, panel } = this;
    const page = ++this.generation;
    const current = () => page === this.generation;
    this.searchController?.abort();
    this.hasMore = false;
    void panel.webview.postMessage({ type: 'loading', paging: true });
    try {
      await this.appendHistory(snapshot, this.limit + pageSize, page, current);
    } catch (error) {
      if (!current()) return;
      this.stopHistory();
      this.snapshot = undefined;
      this.output.appendLine(`${snapshot.root}: ${error.message}`);
      void panel.webview.postMessage({ type: 'error', message: 'Could not read commit history. See Git ++ in the Output panel for details.' });
    }
  }

  async search({ query, request, page, after }) {
    const { snapshot, panel } = this;
    if (!panel || !snapshot || page !== this.generation || page !== snapshot.data.page ||
        typeof query !== 'string' || !query.trim() || !Number.isSafeInteger(request)) return;
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    const current = () => !controller.signal.aborted && page === this.generation;
    const { root, tips } = snapshot;
    const { firstParent, mergesOnly } = snapshot.data;
    const options = { signal: controller.signal, firstParent, mergesOnly };
    try {
      const match = await findHistoryMatch(root, this.git.path, tips, query.trim(), {
        ...options,
        after: typeof after === 'string' ? after : undefined,
      });
      if (!current()) return;
      while (current() && match && match.position > snapshot.data.commits.length && this.hasMore) {
        await this.appendHistory(snapshot, this.limit + pageSize, page, current);
      }
      if (current()) void panel.webview.postMessage({ type: 'searchResult', request, page, hash: match?.hash });
    } catch (error) {
      if (!current()) return;
      this.output.appendLine(`${root}: Commit search failed: ${error.message}`);
      void panel.webview.postMessage({
        type: 'searchResult', request, page, error: 'Search failed. See Git ++ in the Output panel for details.',
      });
    } finally {
      if (this.searchController === controller) this.searchController = undefined;
    }
  }

  displayedCommit(hash) {
    if (this.snapshot?.root === this.root) return this.snapshot.data.commits.find(commit => commit.hash === hash);
  }

  showCommitAction(action, context) {
    if (!this.panel || context?.webviewSection !== 'commit' || context.commitContext !== this.commitContext ||
        this.snapshot?.data.commitContext !== this.commitContext || this.commitAction?.running) return;
    const commit = this.displayedCommit(context.hash);
    if (!commit || this.sidebar.isRunning(this.root)) return;
    const request = ++this.commitActionRequest;
    this.commitAction = { request, action, commit, root: this.root };
    void this.panel.webview.postMessage({ type: 'showCommitAction', request, action, commit });
  }

  async runCommitAction({ request, options }) {
    const pending = this.commitAction;
    if (!pending || pending.request !== request || pending.running || !options || typeof options !== 'object') return;
    const { root, action, commit } = pending;
    const panel = this.panel;
    const post = message => {
      if (pending === this.commitAction) void panel.webview.postMessage({ request, ...message });
    };
    pending.running = true;
    let attempted = false;
    try {
      const ran = await this.sidebar.runRepositoryOperation(root, () => {
        attempted = true;
        return applyCommitAction(root, this.git.path, commit, action, options);
      });
      if (ran) {
        post({ type: 'closeCommitAction' });
        if (pending === this.commitAction) this.commitAction = undefined;
      } else {
        post({ type: 'commitActionError', message: 'The repository is unavailable or busy. Try again.' });
      }
    } catch (error) {
      const message = error.stderr?.trim() || error.message;
      this.output.appendLine(`${root}: Commit action failed: ${message}`);
      post({ type: 'commitActionError', message });
    } finally {
      pending.running = false;
      if (attempted) this.refreshRepository(root);
    }
  }

  cancelDiffRequests() {
    this.diffController?.abort();
    this.fileController?.abort();
  }

  clearDiff() {
    this.cancelDiffRequests();
    this.fileContents.clear();
    this.diffPreview = undefined;
    this.sidebar.setCommitFiles();
  }

  closeFileDiff() {
    this.fileOperation = (this.fileOperation ?? Promise.resolve()).then(async () => {
      const { tabGroups } = vscode.window;
      const column = this.fileDiffGroup?.viewColumn;
      if (column === undefined || column === this.panel?.viewColumn) return;
      const group = tabGroups.all.find(group => group.viewColumn === column);
      if (!group) return;
      const tabs = group.tabs.filter(isFileDiff);
      if (tabs.length) await tabGroups.close(tabs, true);
    }).catch(error => {
      this.output.appendLine(`Could not close the file diff: ${error.message}`);
    });
  }

  async previewDiff({ hash: selectedHash, compareWith }) {
    let commit = this.displayedCommit(selectedHash);
    if (!commit || !this.panel) return;
    let base;
    if (compareWith !== undefined) {
      base = this.displayedCommit(compareWith);
      if (!base || base === commit) return;
      const commits = this.snapshot.data.commits;
      if (commits.indexOf(base) < commits.indexOf(commit)) [commit, base] = [base, commit];
    }
    const { hash, shortHash } = commit;
    const parent = base?.hash ?? commit.parents[0];
    const baseShortHash = base?.shortHash;
    this.cancelDiffRequests();
    this.fileContents.clear();
    this.closeFileDiff();
    const controller = new AbortController();
    this.diffController = controller;
    const { root } = this;
    const preview = { request: ++this.diffRequest, root, hash, parent, baseShortHash };
    const heading = { request: preview.request, shortHash, baseShortHash };
    this.diffPreview = preview;
    this.sidebar.setCommitFiles(heading);
    void this.sidebar.revealCommitFiles();
    try {
      preview.files = await readCommitFiles(root, this.git.path, hash, parent, controller.signal);
      if (!controller.signal.aborted) this.sidebar.setCommitFiles({ ...heading, files: preview.files });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.output.appendLine(`${root}: Could not read the diff for ${hash}: ${error.message}`);
      this.sidebar.setCommitFiles({ ...heading, error: 'Could not load changed files. See Git ++ in the Output panel.' });
    } finally {
      if (this.diffController === controller) this.diffController = undefined;
    }
  }

  openFileDiff({ request, index } = {}) {
    const { diffPreview: preview, panel } = this;
    if (!panel || preview?.request !== request || !Number.isInteger(index)) return;
    const file = preview?.files?.[index];
    if (!file) return;
    this.fileController?.abort();
    const controller = new AbortController();
    this.fileController = controller;
    const { root, hash, parent } = preview;
    const name = basename(file.path);
    const uri = (path, data) => vscode.Uri.from({
      scheme: diffScheme, path: `/${path}`, query: JSON.stringify(data), fragment: 'file-diff',
    });
    this.fileOperation = (this.fileOperation ?? Promise.resolve()).then(async () => {
      if (controller.signal.aborted) return;
      const comparison = await readCommitFileComparison(root, this.git.path, hash, parent, file, controller.signal);
      if (controller.signal.aborted) return;
      const graphColumn = panel.viewColumn;
      panel.reveal(graphColumn, false);
      await vscode.commands.executeCommand('workbench.action.focusBelowGroupWithoutWrap');
      let group = vscode.window.tabGroups.activeTabGroup;
      const hasDiff = group.tabs.some(isFileDiff);
      const hasOtherPreview = group.tabs.some(tab => tab.isPreview && !isFileDiff(tab));
      if (group.viewColumn === panel.viewColumn || (group.tabs.length && !hasDiff) || hasOtherPreview) {
        panel.reveal(panel.viewColumn, false);
        await vscode.commands.executeCommand('workbench.action.newGroupBelow');
        group = vscode.window.tabGroups.activeTabGroup;
      }
      if (controller.signal.aborted) return;
      if (group.viewColumn === panel.viewColumn) throw new Error('Could not create an editor group below the graph.');
      this.fileDiffGroup = group;
      const options = { viewColumn: group.viewColumn, preview: true, preserveFocus: true };
      // Keep only the current comparison. Restored editors can read from Git directly.
      this.fileContents.clear();
      if (comparison.before === undefined) {
        const patch = uri(`${name}.diff`, { root, hash, parent, file });
        this.fileContents.set(fileDiffKey(patch), comparison.patch || emptyDiff);
        await vscode.window.showTextDocument(patch, options);
      } else {
        const before = uri(file.oldPath ?? file.path, { root, revision: file.status === 'A' ? null : parent ?? null, side: 'before' });
        const after = uri(file.path, { root, revision: file.status === 'D' ? null : hash, side: 'after' });
        this.fileContents.set(fileDiffKey(before), comparison.before);
        this.fileContents.set(fileDiffKey(after), comparison.after);
        const shortHash = hash.slice(0, 8);
        const revisionLabel = preview.baseShortHash ? `${preview.baseShortHash} → ${shortHash}` : shortHash;
        await vscode.commands.executeCommand('vscode.diff', before, after, `${name} (${revisionLabel})`, options);
      }
    }).catch(error => {
      if (controller.signal.aborted) return;
      this.output.appendLine(`${root}: Could not open ${file.path} at ${hash}: ${error.message}`);
      void vscode.window.showErrorMessage('Could not open the file diff. See Git ++ in the Output panel.');
    }).finally(() => {
      if (this.fileController === controller) this.fileController = undefined;
    });
    return this.fileOperation;
  }

  async openWorkingFile({ request, index } = {}) {
    const preview = this.diffPreview;
    if (!preview || preview.request !== request || !Number.isInteger(index)) return;
    const file = preview.files?.[index];
    if (!file) return;
    const uri = vscode.Uri.file(join(preview.root, file.path));
    try {
      const { type } = await vscode.workspace.fs.stat(uri);
      if (this.diffPreview !== preview) return;
      if (!(type & vscode.FileType.File)) {
        void vscode.window.showInformationMessage(`"${file.path}" is not a file in the working tree.`);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    } catch (error) {
      if (this.diffPreview !== preview) return;
      if (error.code === 'FileNotFound') {
        void vscode.window.showInformationMessage(`"${file.path}" does not exist in the working tree.`);
        return;
      }
      this.output.appendLine(`${preview.root}: Could not open ${file.path}: ${error.message}`);
      void vscode.window.showErrorMessage('Could not open the working tree file. See Git ++ in the Output panel.');
    }
  }

  async resolveSelection(root, fullName, refs, branches, signal) {
    if (!fullName) return {};
    if (!fullName.startsWith('refs/tags/')) {
      const branch = branches.find(ref => ref.fullName === fullName);
      return branch ? { hash: branch.hash, branch: true } : {};
    }
    const ref = refs.find(ref => ref.fullName === fullName);
    if (!ref) return { warning: `Could not find the commit for ${fullName}.` };
    try {
      return { hash: ref.hash ?? await resolveCommit(root, this.git.path, fullName, signal), label: ref.name };
    } catch {
      return { warning: `Could not find the commit for ${ref.name}.` };
    }
  }

  dispose() {
    this.ready = false;
    this.generation++;
    this.refCheck?.abort();
    this.stopHistory();
    this.searchController?.abort();
    this.panel?.dispose();
  }
}

function webviewHtml(webview, media) {
  const nonce = randomBytes(18).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
  const refreshIcon = webview.asWebviewUri(vscode.Uri.joinPath(media, 'git-refresh.svg'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}">
  <title>Git ++ Commit Graph</title>
</head>
<body>
  <header id="graph-toolbar">
    <div class="search-area">
      <input id="commit-search" type="search" placeholder="Search commit messages or hashes" aria-label="Search commit messages or hashes" />
      <label class="graph-option" title="Show only merge commits">
        <input id="merges-only" type="checkbox" disabled /> merges
      </label>
      <label class="graph-option" title="Follow only the first parent of each merge commit">
        <input id="first-parent" type="checkbox" disabled /> first-parent
      </label>
      <label class="graph-option" title="Draw graph lines with straight segments">
        <input id="polyline" type="checkbox" /> Polyline
      </label>
      <label class="graph-option" title="Limit graph lines and commit dots to three colors">
        <input id="three-colors" type="checkbox" /> 3 Colors
      </label>
      <span id="search-status" role="status"></span>
      <span id="scope"></span>
    </div>
    <div class="actions">
      <button id="all" hidden>Back to Filtered History</button>
      <button id="refresh" type="button" aria-label="Refresh" title="Refresh">
        <img src="${refreshIcon}" alt="" width="18" height="18" />
      </button>
    </div>
  </header>
  <div id="graph-scroll">
    <p id="status" role="status">Loading commit history...</p>
    <main id="history" aria-label="Commit history" hidden>
      <table id="commit-table">
        <colgroup><col><col><col><col><col></colgroup>
        <thead>
          <tr>
            <th id="lane-header" class="lane" scope="col">Graph</th>
            <th scope="col">Commit</th>
            <th scope="col">Author</th>
            <th class="date" scope="col">Time</th>
            <th class="hash" scope="col">Commit</th>
          </tr>
        </thead>
        <tbody id="commits"></tbody>
        <tfoot id="pagination" hidden>
          <tr><td colspan="5"><span id="page-loading" role="status" hidden>Loading older commits...</span></td></tr>
        </tfoot>
      </table>
    </main>
  </div>
  <div id="tag-tooltip" role="tooltip" hidden></div>
  <dialog id="commit-action" aria-labelledby="commit-action-title">
    <form>
      <h2 id="commit-action-title"></h2>
      <p id="commit-action-target"></p>
      <p id="commit-action-description" hidden></p>
      <fieldset>
        <label id="commit-action-name-field" hidden>
          <span></span>
          <input name="name" type="text" autocomplete="off" spellcheck="false" />
        </label>
        <div id="commit-action-tag-fields" hidden>
          <fieldset class="commit-action-tag-types">
            <legend>Type</legend>
            <label class="commit-action-choice"><input name="tagType" type="radio" value="lightweight" checked /> Lightweight</label>
            <label class="commit-action-choice"><input name="tagType" type="radio" value="annotated" /> Annotated</label>
            <label class="commit-action-choice"><input name="tagType" type="radio" value="signed" /> Signed</label>
          </fieldset>
          <label id="commit-action-message-field" hidden>Message
            <textarea name="tagMessage" rows="4"></textarea>
          </label>
        </div>
        <div id="commit-action-checkout-fields" hidden>
          <label class="commit-action-choice"><input name="merge" type="checkbox" /> Merge local changes</label>
          <label class="commit-action-choice"><input name="submodules" type="checkbox" /> Update submodules recursively</label>
        </div>
        <label id="commit-action-parent-field" hidden>Mainline parent
          <select name="mainline"></select>
        </label>
      </fieldset>
      <p id="commit-action-error" role="alert" hidden></p>
      <div class="commit-action-buttons">
        <button type="submit" value="apply" class="primary"></button>
        <button type="submit" value="checkout" hidden>Create and Checkout</button>
        <button type="button" value="cancel">Cancel</button>
      </div>
    </form>
  </dialog>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

async function activate(context) {
  const output = vscode.window.createOutputChannel('Git ++');
  context.subscriptions.push(output);
  const { api, fallback } = await openGit(output);
  if (fallback) context.subscriptions.push(fallback);
  const branchFilter = new BranchFilter(context.workspaceState, output);
  const branchColors = new BranchColors(context.workspaceState, output);
  const sidebar = new SidebarView(
    context.extensionUri, api, output, branchFilter, {
      workspaceState: context.workspaceState,
      onShowGraph: () => graph.show((activeRepository() ?? api.repositories[0])?.rootUri.fsPath),
      onFilterChanged: root => graph.filterChanged(root),
      onOpenFileDiff: message => graph.openFileDiff(message),
      onOpenWorkingFile: message => graph.openWorkingFile(message),
    },
  );
  const graph = new GraphView(context.extensionUri, api.git, output, branchFilter, branchColors, sidebar, context.workspaceState, refresh);
  const watches = new Map();
  const timers = new Map();

  function activeRepository() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri && api.getRepository(uri);
  }

  function stopRefreshTimer(root) {
    clearTimeout(timers.get(root));
    timers.delete(root);
  }

  function refresh(root, refreshRemoteTags = false, onlyIfChanged = false) {
    if (root === undefined) timers.forEach((_timer, name) => stopRefreshTimer(name));
    else stopRefreshTimer(root);
    const refs = sidebar.refresh(root, { refreshRemoteTags, onlyIfChanged });
    if (root === undefined || graph.root === root) {
      const current = refs?.get(graph.root);
      if (onlyIfChanged) graph.refreshIfChanged(current);
      else void graph.load(current);
    }
  }

  function watch(repository) {
    if (watches.has(repository)) return;
    const root = repository.rootUri.fsPath;
    watches.set(repository, repository.state.onDidChange(() => {
      stopRefreshTimer(root);
      timers.set(root, setTimeout(() => refresh(root, false, true), 250));
    }));
  }

  api.repositories.forEach(watch);
  context.subscriptions.push(
    graph,
    sidebar,
    vscode.workspace.registerTextDocumentContentProvider(diffScheme, {
      async provideTextDocumentContent(uri) {
        const { root, hash, parent, file, revision } = JSON.parse(uri.query);
        if (!api.repositories.some(repository => repository.rootUri.fsPath === root)) {
          throw new Error('The Git repository is no longer open.');
        }
        const cached = graph.fileContents.get(fileDiffKey(uri));
        if (cached !== undefined) return cached;
        if (revision !== undefined) {
          return revision === null ? '' : readCommitFileVersion(root, api.git.path, revision, uri.path.slice(1));
        }
        // VS Code can restore whole-commit diffs opened by an earlier version.
        const patch = file ? await readCommitFileDiff(root, api.git.path, hash, parent, file)
          : await readCommitDiff(root, api.git.path, hash, parent);
        return patch || emptyDiff;
      },
    }),
    vscode.window.registerWebviewViewProvider(viewId, sidebar),
    vscode.tasks.onDidEndTask(({ execution }) => {
      const { type, repository } = execution.task.definition;
      if (type === taskType) refresh(repository, true);
    }),
    api.onDidOpenRepository(repository => {
      watch(repository);
      refresh(repository.rootUri.fsPath);
      if (api.repositories.length === 1) sidebar.showGraphIfVisible();
    }),
    api.onDidCloseRepository(repository => {
      watches.get(repository)?.dispose();
      watches.delete(repository);
      const root = repository.rootUri.fsPath;
      if (graph.root === root) graph.dispose();
      refresh(root);
    }),
    { dispose() { timers.forEach(clearTimeout); watches.forEach(subscription => subscription.dispose()); } },
    vscode.commands.registerCommand('gitPlusPlus.refresh', async () => {
      await fallback?.scan();
      refresh(undefined, true);
    }),
    vscode.commands.registerCommand('gitPlusPlus.switchBranch', async context => {
      if (await sidebar.changeLocalBranch(context, 'switch')) refresh(context.root);
    }),
    vscode.commands.registerCommand('gitPlusPlus.deleteBranch', async context => {
      if (await sidebar.changeLocalBranch(context, 'delete')) refresh(context.root);
    }),
    vscode.commands.registerCommand('gitPlusPlus.deleteRemoteBranch', async context => {
      if (await sidebar.changeRemoteBranch(context, 'delete')) refresh(context.root);
    }),
    vscode.commands.registerCommand('gitPlusPlus.switchRemoteBranch', async context => {
      if (await sidebar.changeRemoteBranch(context, 'switch')) refresh(context.root);
    }),
    vscode.commands.registerCommand('gitPlusPlus.pullBranch', async context => {
      if (await sidebar.syncBranch(context, 'pull')) refresh(context.root, true);
    }),
    vscode.commands.registerCommand('gitPlusPlus.pushBranch', async context => {
      if (await sidebar.syncBranch(context, 'push')) refresh(context.root);
    }),
    vscode.commands.registerCommand('gitPlusPlus.deleteTag', async context => {
      if (await sidebar.deleteTag(context)) refresh(context.root, true);
    }),
    ...Object.entries(commitActions).map(([command, action]) =>
      vscode.commands.registerCommand(`gitPlusPlus.${command}`, context => graph.showCommitAction(action, context))),
    vscode.commands.registerCommand('gitPlusPlus.openGraph', async context => {
      const repository = activeRepository();
      let root = context?.webviewSection === 'repository' ? context.root : repository?.rootUri.fsPath;
      if (!root) root = (await selectRepository(api))?.rootUri.fsPath;
      if (api.repositories.some(repository => repository.rootUri.fsPath === root)) graph.open(root);
    }),
    vscode.commands.registerCommand('gitPlusPlus.revealRef', (root, fullName) => {
      if (typeof fullName !== 'string') return;
      const group = /^refs\/(heads|remotes|tags)\//.exec(fullName)?.[1];
      if (!group || !api.repositories.some(repository => repository.rootUri.fsPath === root)) return;
      if (group === 'tags' || sidebar.isBranchChecked(root, fullName)) graph.open(root, fullName);
    }),
  );
}

module.exports = { activate };
