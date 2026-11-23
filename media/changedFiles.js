'use strict';

function createChangedFiles(vscode) {
  const toolbar = document.getElementById('diff-file-toolbar');
  const title = document.getElementById('diff-title');
  const list = document.getElementById('diff-files');
  const status = document.getElementById('diff-files-status');
  const listButton = document.getElementById('diff-list-mode');
  const treeButton = document.getElementById('diff-tree-mode');
  let files = [];
  let request;
  let displayedRequest;
  let mode = 'list';
  let selectedIndex;
  let selectedButton;

  function fileRow(file, index, label) {
    const fileRequest = displayedRequest;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row ref';
    button.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    const badge = document.createElement('span');
    badge.className = 'diff-file-status';
    badge.dataset.status = file.status;
    badge.textContent = file.status;
    const text = document.createElement('span');
    text.className = 'label';
    text.textContent = label ?? button.title;
    button.append(badge, text);
    if (index === selectedIndex) {
      button.setAttribute('aria-current', 'true');
      selectedButton = button;
    }
    button.addEventListener('click', () => {
      if (fileRequest !== request) return;
      selectedButton?.removeAttribute('aria-current');
      selectedIndex = index;
      selectedButton = button;
      button.setAttribute('aria-current', 'true');
      vscode.postMessage({ type: 'openFileDiff', request: fileRequest, index });
    });
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'diff-file-open';
    open.title = 'Open File in Editor';
    open.setAttribute('aria-label', `Open ${file.path} in Editor`);
    open.textContent = '↗';
    open.addEventListener('click', () => {
      if (fileRequest !== request) return;
      vscode.postMessage({ type: 'openWorkingFile', request: fileRequest, index });
    });

    const row = document.createElement('div');
    row.className = 'diff-file-row';
    row.append(button, open);
    return row;
  }

  function fileTree() {
    const root = { folders: new Map(), files: [] };
    files.forEach((file, index) => {
      const parts = file.path.split('/');
      const name = parts.pop();
      let folder = root;
      for (const part of parts) {
        if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
        folder = folder.folders.get(part);
      }
      folder.files.push({ file, index, name });
    });

    function renderFolder({ folders, files }) {
      const content = document.createDocumentFragment();
      for (const [name, folder] of folders) {
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.className = 'row disclosure';
        summary.textContent = name;
        summary.title = name;
        const children = document.createElement('div');
        children.className = 'children';
        children.append(renderFolder(folder));
        details.append(summary, children);
        content.append(details);
      }
      for (const { file, index, name } of files) content.append(fileRow(file, index, name));
      return content;
    }
    return renderFolder(root);
  }

  function render() {
    listButton.setAttribute('aria-pressed', String(mode === 'list'));
    treeButton.setAttribute('aria-pressed', String(mode === 'tree'));
    selectedButton = undefined;
    const content = document.createDocumentFragment();
    if (mode === 'tree') content.append(fileTree());
    else files.forEach((file, index) => content.append(fileRow(file, index)));
    list.replaceChildren(content);
  }

  function setMode(next, persist = false) {
    if (next === mode || (next !== 'list' && next !== 'tree')) return;
    mode = next;
    render();
    if (persist) vscode.postMessage({ type: 'changedFilesMode', mode });
  }

  listButton.addEventListener('click', () => setMode('list', true));
  treeButton.addEventListener('click', () => setMode('tree', true));

  return {
    setMode,
    show(commit) {
      request = commit?.request;
      const heading = commit?.baseShortHash ? `${commit.baseShortHash} → ${commit.shortHash}` : commit?.shortHash ?? '';
      toolbar.hidden = !commit;
      const pending = Boolean(commit && !commit.files && commit.error === undefined);
      list.setAttribute('aria-busy', String(pending));
      if (pending) {
        if (displayedRequest === undefined) {
          title.textContent = heading;
          status.hidden = true;
        }
        return;
      }

      if (displayedRequest !== request) {
        selectedIndex = undefined;
        list.scrollTop = 0;
      }
      displayedRequest = request;
      files = commit?.files ?? [];
      title.textContent = heading;
      const message = !commit ? 'Click a Graph cell to see its changed files.' :
        commit.error ?? (files.length ? '' : commit.baseShortHash ? 'No file changes between these commits.' : 'No file changes in this commit.');
      status.textContent = message;
      status.hidden = !message;
      render();
    },
  };
}
