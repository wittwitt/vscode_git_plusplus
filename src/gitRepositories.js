'use strict';

const vscode = require('vscode');
const { dirname, isAbsolute, relative, resolve, sep } = require('node:path');
const { git } = require('./git');

async function openGit(output) {
  const extension = vscode.extensions.getExtension('vscode.git');
  try {
    const exports = extension?.isActive ? extension.exports : await extension?.activate();
    if (exports && exports.enabled !== false) return { api: exports.getAPI(1) };
    output.appendLine('The built-in VS Code Git model is unavailable. Using the Git CLI.');
  } catch (error) {
    output.appendLine(`The built-in VS Code Git API is unavailable. Using the Git CLI: ${error.message}`);
  }
  const fallback = new CliRepositories(output);
  await fallback.scan();
  return { api: fallback, fallback };
}

class CliRepositories {
  constructor(output) {
    this.output = output;
    this.git = { path: undefined };
    this.repositories = [];
    this.entries = new Map();
    this.generation = 0;
    this.open = new vscode.EventEmitter();
    this.close = new vscode.EventEmitter();
    this.onDidOpenRepository = this.open.event;
    this.onDidCloseRepository = this.close.event;
    this.listeners = [
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.scan()),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        const uri = editor?.document.uri;
        if (this.git.path && uri?.scheme === 'file' && !this.getRepository(uri)) void this.scan();
      }),
    ];
  }

  get emptyMessage() {
    if (!this.git.path) return 'Could not find Git. Check the Git: Path setting in VS Code, then refresh Git ++.';
  }

  async findGit() {
    const configured = vscode.workspace.getConfiguration('git').get('path');
    const candidates = [...(Array.isArray(configured) ? configured : [configured]), 'git'];
    if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git');
    for (const candidate of new Set(candidates)) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        await git(undefined, candidate, ['--version']);
        this.output.appendLine(`Git CLI: ${candidate}`);
        return candidate;
      } catch (error) {
        this.output.appendLine(`Could not start Git CLI ${candidate}: ${error.message}`);
      }
    }
  }

  async scan() {
    const generation = ++this.generation;
    const gitPath = this.git.path ?? await this.findGit();
    if (generation !== this.generation || !gitPath) return;
    this.git.path = gitPath;
    const sources = (vscode.workspace.workspaceFolders ?? [])
      .filter(folder => folder.uri.scheme === 'file')
      .map(folder => folder.uri.fsPath);
    for (const { uri } of vscode.workspace.textDocuments) {
      if (uri.scheme === 'file') sources.push(dirname(uri.fsPath));
    }
    const discovered = await Promise.all([...new Set(sources)].map(async cwd => {
      try {
        const result = await git(cwd, gitPath, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
        const [root, gitDir, commonDir] = result.replace(/\r?\n$/, '').split(/\r?\n/);
        return { root, gitDir, commonDir: resolve(cwd, commonDir) };
      } catch (error) {
        if (error.code !== 128 && error.code !== 'ENOENT') this.output.appendLine(`${cwd}: ${error.message}`);
      }
    }));
    if (generation !== this.generation) return;
    const next = new Map();
    for (const entry of discovered) {
      if (!entry || next.has(entry.root)) continue;
      next.set(entry.root, this.entries.get(entry.root) ?? this.watch(entry));
    }
    const previous = this.entries;
    this.entries = next;
    this.repositories = [...next.values()].map(entry => entry.repository);
    for (const [root, entry] of previous) {
      if (!next.has(root)) {
        this.close.fire(entry.repository);
        entry.dispose();
      }
    }
    for (const [root, entry] of next) {
      if (!previous.has(root)) this.open.fire(entry.repository);
    }
  }

  watch({ root, gitDir, commonDir }) {
    const changed = new vscode.EventEmitter();
    const watch = (directory, pattern) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, pattern));
      watcher.onDidChange(() => changed.fire());
      watcher.onDidCreate(() => changed.fire());
      watcher.onDidDelete(() => changed.fire());
      return watcher;
    };
    const watchers = gitDir === commonDir
      ? [watch(gitDir, '{HEAD,config,packed-refs,refs/**}')]
      : [watch(gitDir, 'HEAD'), watch(commonDir, '{config,packed-refs,refs/**}')];
    return {
      repository: { rootUri: vscode.Uri.file(root), state: { onDidChange: changed.event } },
      dispose() { watchers.forEach(watcher => watcher.dispose()); changed.dispose(); },
    };
  }

  getRepository(uri) {
    if (uri.scheme !== 'file') return;
    let best;
    for (const repository of this.repositories) {
      const root = repository.rootUri.fsPath;
      const path = relative(root, uri.fsPath);
      if (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) &&
          (!best || root.length > best.rootUri.fsPath.length)) best = repository;
    }
    return best;
  }

  dispose() {
    this.generation++;
    this.listeners.forEach(listener => listener.dispose());
    this.entries.forEach(entry => entry.dispose());
    this.open.dispose();
    this.close.dispose();
  }
}

module.exports = { openGit };
