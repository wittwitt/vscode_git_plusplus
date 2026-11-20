'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { basename } = require('node:path');
const { git, buildRefTree, readRefs, readRemoteNames, readRemoteConfig, resolveRemoteBranchRef, readRemoteTagNames } = require('./git');

const viewId = 'gitPlusPlus.refs';
const taskType = 'gitPlusPlus';
const changedFilesModeKey = 'gitPlusPlus.diffFileMode';
const networkGitOptions = { timeout: 120000 };
const remoteTagCacheMs = 60_000;
const remoteCollator = new Intl.Collator(undefined, { numeric: true });

function groupSidebarRefs(refs, remoteNames) {
  const remotes = new Map(remoteNames.map(name => [name, []]));
  const prefixes = [...remoteNames].sort((a, b) => b.length - a.length);
  const locals = [];
  const tags = [];
  const groupedRefs = refs.map(ref => {
    if (ref.group === 'heads') locals.push(ref);
    if (ref.group === 'tags') tags.push(ref);
    if (ref.group !== 'remotes') return ref;
    const remote = prefixes.find(name => ref.name.startsWith(`${name}/`)) ?? ref.name.split('/')[0];
    const groupedRef = { ...ref, remote };
    if (!remotes.has(remote)) remotes.set(remote, []);
    remotes.get(remote).push(groupedRef);
    return groupedRef;
  });
  const remoteGroups = [...remotes].sort(([a], [b]) => remoteCollator.compare(a, b))
    .map(([name, branches]) => ({
      id: `remotes/${name}`,
      label: `remote/${name}`,
      children: buildRefTree(branches, ref => ref.name.slice(name.length + 1) || ref.name),
    }));
  return {
    refs: groupedRefs,
    tagNames: tags.map(ref => ref.fullName),
    groups: [
      { id: 'heads', label: 'local', children: buildRefTree(locals) },
      ...remoteGroups,
      { id: 'tags', label: 'tags', children: buildRefTree(tags) },
    ],
  };
}

function localTagNames(tagNames, remoteTags) {
  return remoteTags ? tagNames.filter(name => !remoteTags.has(name)) : [];
}

async function selectRepository(api) {
  const { repositories } = api;
  if (repositories.length === 1) return repositories[0];
  if (!repositories.length) {
    void vscode.window.showInformationMessage(api.emptyMessage ?? 'Open a Git repository first.');
    return;
  }
  const choices = repositories.map(repository => ({
    label: basename(repository.rootUri.fsPath),
    description: repository.rootUri.fsPath,
    repository,
  }));
  return (await vscode.window.showQuickPick(choices, { placeHolder: 'Select a Git repository' }))?.repository;
}

class SidebarView {
  constructor(extensionUri, api, output, branchFilter, {
    workspaceState, onShowGraph, onFilterChanged, onOpenFileDiff,
  }) {
    this.extensionUri = extensionUri;
    this.api = api;
    this.output = output;
    this.branchFilter = branchFilter;
    this.workspaceState = workspaceState;
    this.onShowGraph = onShowGraph;
    this.onFilterChanged = onFilterChanged;
    this.onOpenFileDiff = onOpenFileDiff;
    this.refsByRoot = new Map();
    this.refRequests = new Map();
    this.repositorySnapshots = new Map();
    this.remoteTags = new Map();
    this.starting = new Set();
  }

  isBranchChecked(root, fullName) {
    const refs = this.refsByRoot.get(root) ?? [];
    return this.branchFilter.selected(root, refs).some(ref => ref.fullName === fullName);
  }

  setCommitFiles(commit) {
    this.commit = commit;
    void this.view?.webview.postMessage({ type: 'commitFiles', commit });
  }

  async revealCommitFiles() {
    if (this.view?.visible) return;
    if (this.view) {
      this.view.show(true);
      return;
    }
    try {
      await vscode.commands.executeCommand(`${viewId}.focus`, { preserveFocus: true });
    } catch (error) {
      this.output.appendLine(`Could not open the Git ++ sidebar: ${error.message}`);
    }
  }

  showGraphIfVisible() {
    if (this.view?.visible && !this.commit) this.onShowGraph();
  }

  refresh(root, { refreshRemoteTags = false, onlyIfChanged = false } = {}) {
    const view = this.view;
    const roots = new Set(this.api.repositories.map(repository => repository.rootUri.fsPath));
    for (const [name, request] of this.refRequests) {
      if (roots.has(name)) continue;
      request.abort();
      this.refRequests.delete(name);
      this.refsByRoot.delete(name);
      this.repositorySnapshots.delete(name);
    }
    for (const name of this.remoteTags.keys()) {
      if (!roots.has(name) || (refreshRemoteTags && (root === undefined || root === name))) this.invalidateRemoteTags(name);
    }
    if (!this.ready) return;

    const refsByRoot = new Map();
    const snapshots = [];
    for (const name of roots) {
      if (root !== undefined && root !== name) continue;
      this.refRequests.get(name)?.abort();
      const request = new AbortController();
      this.refRequests.set(name, request);
      const refs = readRefs(name, this.api.git.path, request.signal);
      refsByRoot.set(name, refs);
      snapshots.push(this.snapshotRepository(name, refs, request.signal));
    }
    void Promise.all(snapshots).then(results => {
      if (view !== this.view || !this.ready) return;
      const repositories = [];
      for (const { root, remote, signal, snapshot, ...repository } of results) {
        if (signal.aborted) continue;
        const unchanged = Boolean(snapshot && this.repositorySnapshots.get(root) === snapshot);
        if (snapshot) this.repositorySnapshots.set(root, snapshot);
        else this.repositorySnapshots.delete(root);
        const { refs = [], groups, tagNames = [] } = snapshot ?? {};
        this.refsByRoot.set(root, refs);
        const lookup = tagNames.length ? this.lookupRemoteTags(root, remote) : undefined;
        if (!onlyIfChanged || !unchanged) {
          repositories.push({
            root, ...repository, groups, localOnlyTags: localTagNames(tagNames, lookup?.tags),
            checkedBranches: this.branchFilter.selected(root, refs).map(ref => ref.fullName),
          });
        }
      }
      if (onlyIfChanged && !repositories.length) return;
      void view.webview.postMessage({
        type: 'repositories', repositories, roots: this.api.repositories.map(repository => repository.rootUri.fsPath),
        emptyMessage: this.api.emptyMessage,
      });
    });
    return refsByRoot;
  }

  async snapshotRepository(root, refsPromise, signal) {
    const label = basename(root) || root;
    try {
      const [refs, remote] = await Promise.all([refsPromise, readRemoteConfig(root, this.api.git.path, signal)]);
      const refsKey = JSON.stringify(refs);
      const previous = this.repositorySnapshots.get(root);
      const snapshot = previous?.refsKey === refsKey && previous.fingerprint === remote.fingerprint ? previous : {
        refsKey, fingerprint: remote.fingerprint, ...groupSidebarRefs(refs, remote.names),
      };
      return { root, label, remote, signal, snapshot };
    } catch (error) {
      if (!signal.aborted) this.output.appendLine(`${root}: ${error.message}`);
      return { root, label, signal, error: 'Could not load branches and tags. Refresh to try again.' };
    }
  }

  invalidateRemoteTags(root) {
    this.remoteTags.get(root)?.controller.abort();
    this.remoteTags.delete(root);
  }

  lookupRemoteTags(root, { fingerprint, names }) {
    const cached = this.remoteTags.get(root);
    if (cached?.fingerprint === fingerprint && cached.expires > Date.now()) return cached;
    this.invalidateRemoteTags(root);
    const controller = new AbortController();
    const entry = { fingerprint, controller, expires: Infinity, tags: cached?.fingerprint === fingerprint ? cached.tags : undefined };
    this.remoteTags.set(root, entry);
    void readRemoteTagNames(root, this.api.git.path, names, controller.signal).then(tags => {
      entry.tags = tags;
      entry.expires = Date.now() + remoteTagCacheMs;
      const snapshot = this.repositorySnapshots.get(root);
      if (this.ready && this.remoteTags.get(root) === entry && snapshot?.fingerprint === fingerprint) {
        void this.view.webview.postMessage({ type: 'localOnlyTags', root, names: localTagNames(snapshot.tagNames, tags) });
      }
    });
    return entry;
  }

  clearView() {
    this.view = undefined;
    this.ready = false;
    for (const request of this.refRequests.values()) request.abort();
    this.refRequests.clear();
    this.refsByRoot.clear();
    this.repositorySnapshots.clear();
  }

  dispose() {
    this.clearView();
    for (const root of this.remoteTags.keys()) this.invalidateRemoteTags(root);
  }

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const { webview } = view;
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const receiver = webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') {
        this.ready = true;
        void webview.postMessage({ type: 'changedFilesMode', mode: this.workspaceState.get(changedFilesModeKey) });
        this.setCommitFiles(this.commit);
        void this.refresh();
      }
      if (message?.type === 'openFileDiff') return this.onOpenFileDiff(message);
      if (message?.type === 'changedFilesMode' && (message.mode === 'list' || message.mode === 'tree')) {
        return this.workspaceState.update(changedFilesModeKey, message.mode);
      }
      if (message?.type === 'fetch') void this.fetch(message.root);
      if (message?.type === 'revealRef') {
        void vscode.commands.executeCommand('gitPlusPlus.revealRef', message.root, message.fullName);
      }
      if ((message?.type === 'filterBranch' || message?.type === 'filterBranchGroup') &&
          this.api.repositories.some(repo => repo.rootUri.fsPath === message.root)) {
        const refs = this.refsByRoot.get(message.root) ?? [];
        const changed = message.type === 'filterBranch'
          ? this.branchFilter.change(message.root, refs, message.fullName, message.checked)
          : this.branchFilter.changeGroup(message.root, refs, message.group, message.checked);
        if (changed) this.onFilterChanged(message.root);
        void webview.postMessage({
          type: 'branchSelection',
          root: message.root,
          checkedBranches: this.branchFilter.selected(message.root, refs).map(ref => ref.fullName),
        });
      }
    });
    const visibility = view.onDidChangeVisibility(() => this.showGraphIfVisible());
    view.onDidDispose(() => {
      receiver.dispose();
      visibility.dispose();
      if (this.view === view) this.clearView();
    });
    const nonce = randomBytes(18).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const filesScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'changedFiles.js'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}">
  <title>Git ++</title>
</head>
<body>
  <section class="sidebar-pane expanded" aria-labelledby="toggle-refs">
    <h2><button id="toggle-refs" type="button" aria-expanded="true" aria-controls="refs-pane">Branches and Tags</button></h2>
    <div id="refs-pane" class="sidebar-pane-body">
      <main id="repositories" aria-label="Git repositories"></main>
      <p id="status" role="status">Loading Git repositories...</p>
    </div>
  </section>
  <section class="sidebar-pane" aria-labelledby="toggle-files">
    <h2><button id="toggle-files" type="button" aria-expanded="false" aria-controls="commit-files">Changed Files</button></h2>
    <div id="commit-files" class="sidebar-pane-body" hidden>
      <div id="diff-file-toolbar" class="diff-file-toolbar" hidden>
        <strong id="diff-title"></strong>
        <div class="diff-layout" role="group" aria-label="File layout">
          <button id="diff-list-mode" type="button" aria-label="List view" title="List view" aria-pressed="true">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke-width="1.5" stroke-linecap="round">
              <path class="diff-list-lines" d="M8 5h8.5M8 10h8.5M8 15h8.5" />
              <g class="diff-list-bullets">
                <circle cx="4" cy="5" r="1.15" /><circle cx="4" cy="10" r="1.15" /><circle cx="4" cy="15" r="1.15" />
              </g>
            </svg>
          </button>
          <button id="diff-tree-mode" type="button" aria-label="Tree view" title="Tree view" aria-pressed="false">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path class="diff-tree-folder" d="M3 3.75h4l1.5 1.5h3.75v4H3z" />
              <path class="diff-tree-branches" d="M5 9.25V15a1 1 0 0 0 1 1h4.5m-5.5-4h5.5" />
              <path class="diff-tree-files" d="M13 12h3.5M13 16h3.5" />
            </svg>
          </button>
        </div>
      </div>
      <p id="diff-files-status" role="status">Click a Graph cell to see its changed files.</p>
      <div id="diff-files"></div>
    </div>
  </section>
  <script nonce="${nonce}" src="${filesScript}"></script>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    this.showGraphIfVisible();
  }

  isRunning(root) {
    if (this.starting.has(root) || vscode.tasks.taskExecutions.some(({ task }) =>
      task.definition.type === taskType && task.definition.repository === root)) {
      void vscode.window.showInformationMessage('A Git ++ command is already running in this repository.');
      return true;
    }
    return false;
  }

  async runRepositoryOperation(root, operation) {
    if (!this.api.repositories.some(repository => repository.rootUri.fsPath === root) || this.isRunning(root)) {
      return false;
    }
    this.starting.add(root);
    try {
      return (await operation()) !== false;
    } finally {
      this.starting.delete(root);
    }
  }

  async changeLocalBranch(context, operation) {
    if (context?.webviewSection !== 'localBranch') return;
    const { root, fullName } = context;
    const branch = this.refsByRoot.get(root)?.find(ref => ref.group === 'heads' && ref.fullName === fullName);
    if (!branch || !this.api.repositories.some(repository => repository.rootUri.fsPath === root)) return;
    if (branch.current || this.isRunning(root)) return;

    const deleting = operation === 'delete';
    this.starting.add(root);
    try {
      if (deleting) {
        const choice = await vscode.window.showWarningMessage(
          `Delete local branch "${branch.name}"?`, { modal: true }, 'Delete Branch',
        );
        if (choice !== 'Delete Branch' ||
            !this.api.repositories.some(repository => repository.rootUri.fsPath === root)) return;
      }
      const args = deleting ? ['branch', '-d', '--', branch.name] : ['switch', '--no-guess', '--', branch.name];
      await git(root, this.api.git.path, args);
      return true;
    } catch (error) {
      const action = deleting ? 'delete' : 'switch to';
      void vscode.window.showErrorMessage(`Could not ${action} "${branch.name}": ${error.stderr?.trim() || error.message}`);
    } finally {
      this.starting.delete(root);
    }
  }

  async changeRemoteBranch(context, operation) {
    if (context?.webviewSection !== 'remoteBranch') return;
    const { root, fullName } = context;
    const branch = this.refsByRoot.get(root)?.find(ref => ref.group === 'remotes' && ref.fullName === fullName);
    if (!branch) return;

    const deleting = operation === 'delete';
    const action = deleting ? 'delete' : 'switch to';
    const { path: gitPath } = this.api.git;
    try {
      return await this.runRepositoryOperation(root, async () => {
        const { remote } = branch;
        if (deleting) {
          if (!(await readRemoteNames(root, gitPath)).includes(remote)) {
            throw new Error(`Remote "${remote}" is no longer configured.`);
          }
          const remoteRef = await resolveRemoteBranchRef(root, gitPath, remote, fullName);
          const remoteBranch = remoteRef.slice('refs/heads/'.length);
          const choice = await vscode.window.showWarningMessage(
            `Delete branch "${remoteBranch}" from remote "${remote}"?`, { modal: true }, 'Delete Remote Branch',
          );
          if (choice !== 'Delete Remote Branch' ||
              !this.api.repositories.some(repository => repository.rootUri.fsPath === root)) return false;
          await git(root, gitPath, ['push', '--no-follow-tags', '--delete', '--', remote, remoteRef]);
        } else {
          const localName = branch.name.slice(remote.length + 1);
          const refs = await readRefs(root, gitPath);
          const localBranch = refs.find(ref => ref.fullName === `refs/heads/${localName}`);
          const args = localBranch
            ? ['switch', '--no-guess', '--', localName]
            : ['switch', '--track', '--create', localName, '--', fullName];
          await git(root, gitPath, args);
        }
        return true;
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not ${action} "${branch.name}": ${error.stderr?.trim() || error.message}`);
    }
  }

  async syncBranch(context, operation) {
    const group = context?.webviewSection === 'localBranch' ? 'heads' :
      context?.webviewSection === 'remoteBranch' ? 'remotes' : undefined;
    if (!group) return;
    const { root, fullName } = context;
    const shownBranch = this.refsByRoot.get(root)?.find(ref => ref.group === group && ref.fullName === fullName);
    if (!shownBranch) return;

    const { path: gitPath } = this.api.git;
    const remoteBranch = group === 'remotes' ? shownBranch : undefined;
    let attempted = false;
    try {
      return await this.runRepositoryOperation(root, async () => {
        const refs = await readRefs(root, gitPath);
        const branch = refs.find(ref => ref.fullName === fullName);
        if (!branch) throw new Error('This branch no longer exists.');

        let localBranch = branch;
        let localName = branch.name;
        let remoteRef;
        if (remoteBranch) {
          localName = branch.name.slice(remoteBranch.remote.length + 1);
          const trackers = refs.filter(ref => ref.group === 'heads' && ref.upstream === fullName &&
            ref.upstreamRemote === remoteBranch.remote);
          localBranch = trackers.find(ref => ref.current) ?? trackers.find(ref => ref.name === localName) ?? trackers[0];
          if (trackers.length > 1 && !localBranch.current && localBranch.name !== localName) {
            const selected = await vscode.window.showQuickPick(trackers.map(ref => ref.name), {
              placeHolder: `Select a local branch that tracks "${branch.name}"`,
            });
            localBranch = trackers.find(ref => ref.name === selected);
            if (!localBranch) return false;
          }
          if (localBranch) localName = localBranch.name;
          remoteRef = await resolveRemoteBranchRef(root, gitPath, remoteBranch.remote, fullName);
        }

        let args;
        if (operation === 'pull') {
          if (!remoteBranch && !localBranch.upstreamRemote) throw new Error('This branch has no upstream.');
          if (!localBranch && refs.some(ref => ref.fullName === `refs/heads/${localName}`)) {
            throw new Error(`Local branch "${localName}" already exists with a different upstream.`);
          }
          if (!localBranch?.current) {
            const action = localBranch ? 'Switch and Pull' : 'Create Branch and Pull';
            const message = localBranch ? `Switch to "${localName}" and run git pull?` :
              `Create and switch to "${localName}" to pull from "${branch.name}"?`;
            const choice = await vscode.window.showInformationMessage(message, { modal: true }, action);
            if (choice !== action || !this.api.repositories.some(repository => repository.rootUri.fsPath === root)) return false;
            const switchArgs = localBranch
              ? ['switch', '--no-guess', '--no-overwrite-ignore', '--', localName]
              : ['switch', '--no-overwrite-ignore', '--track', '--create', localName, '--', fullName];
            attempted = true;
            await git(root, gitPath, switchArgs);
          }
          args = remoteBranch ? ['pull', '--', remoteBranch.remote, remoteRef] : ['pull'];
        } else {
          if (!localBranch) throw new Error('No local branch tracks this remote branch.');
          args = await this.branchPushArgs(root, localBranch, remoteBranch?.remote, remoteRef);
          if (!args) return false;
        }

        if (!this.api.repositories.some(repository => repository.rootUri.fsPath === root)) return attempted;
        if (operation === 'pull') {
          const head = await git(root, gitPath, ['rev-parse', '--symbolic-full-name', 'HEAD']);
          if (head.trim() !== `refs/heads/${localName}`) throw new Error('The checked-out branch changed.');
        }
        attempted = true;
        await git(root, gitPath, args, undefined, undefined, networkGitOptions);
        return true;
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not ${operation} "${shownBranch.name}": ${error.stderr?.trim() || error.message}`);
      return attempted;
    }
  }

  async branchPushArgs(root, branch, remote, target) {
    if (!remote) {
      const remotes = await readRemoteNames(root, this.api.git.path);
      const configuredRemote = branch.pushRemote || branch.upstreamRemote;
      if (configuredRemote && configuredRemote !== '.' && !remotes.includes(configuredRemote)) {
        throw new Error(`Remote "${configuredRemote}" is no longer configured.`);
      }
      if (!remotes.length) throw new Error('No Git remote is configured.');
      remote = remotes.includes(configuredRemote) ? configuredRemote : remotes.length === 1 ? remotes[0] :
        await vscode.window.showQuickPick(remotes, { placeHolder: `Select a remote to push "${branch.name}" to` });
      if (!remotes.includes(remote)) return;

      if (remote === branch.pushRemote && branch.pushRemoteRef.startsWith('refs/heads/')) {
        target = branch.pushRemoteRef;
      } else if (remote === branch.upstreamRemote && branch.upstreamRemoteRef.startsWith('refs/heads/')) {
        target = branch.upstreamRemoteRef;
      }
    }
    return ['push', '--no-follow-tags', ...(!branch.upstreamRemote ? ['--set-upstream'] : []), '--', remote,
      `${branch.fullName}:${target ?? branch.fullName}`];
  }

  async deleteTag(context) {
    if (context?.webviewSection !== 'tag') return;
    const { root, fullName } = context;
    const tag = this.refsByRoot.get(root)?.find(ref => ref.group === 'tags' && ref.fullName === fullName);
    if (!tag) return;

    const localOnly = 'Delete Locally';
    const localAndRemote = 'Delete Locally and Remotely';
    const { path: gitPath } = this.api.git;
    let deletedFrom;
    try {
      return await this.runRepositoryOperation(root, async () => {
        const choice = await vscode.window.showWarningMessage(
          `Delete tag "${tag.name}"?`, { modal: true }, localOnly, localAndRemote,
        );
        if (choice !== localOnly && choice !== localAndRemote) return false;
        if (!this.api.repositories.some(repository => repository.rootUri.fsPath === root)) return false;

        if (choice === localAndRemote) {
          const remotes = await readRemoteNames(root, gitPath);
          if (!remotes.length) throw new Error('No Git remote is configured.');
          const remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(remotes, {
            placeHolder: `Select a remote to delete "${tag.name}" from`,
          });
          if (!remotes.includes(remote) ||
              !this.api.repositories.some(repository => repository.rootUri.fsPath === root)) return false;
          await git(root, gitPath, ['push', '--no-follow-tags', '--delete', '--', remote, fullName]);
          deletedFrom = remote;
        }
        await git(root, gitPath, ['tag', '--delete', '--', tag.name]);
        return true;
      });
    } catch (error) {
      const detail = deletedFrom ? ` locally after deleting it from "${deletedFrom}"` : '';
      void vscode.window.showErrorMessage(`Could not delete tag "${tag.name}"${detail}: ${error.stderr?.trim() || error.message}`);
      return deletedFrom !== undefined;
    }
  }

  async fetch(root) {
    const repository = this.api.repositories.find(repository => repository.rootUri.fsPath === root);
    if (!repository || this.isRunning(root)) return;
    this.starting.add(root);
    try {
      const scope = vscode.workspace.getWorkspaceFolder(repository.rootUri) ?? vscode.TaskScope.Workspace;
      const task = new vscode.Task(
        { type: taskType, repository: root, action: 'fetch' },
        scope, 'Fetch all remotes and tags', 'Git ++', new vscode.ShellExecution('git fetch --all --tags', { cwd: root }), [],
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared };
      await vscode.tasks.executeTask(task);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not fetch all remotes and tags: ${error.stderr?.trim() || error.message}`);
    } finally {
      this.starting.delete(root);
    }
  }
}

module.exports = { SidebarView, viewId, taskType, selectRepository };
