'use strict';

const vscode = acquireVsCodeApi();
const list = document.getElementById('repositories');
const status = document.getElementById('status');
const changedFiles = createChangedFiles(vscode);
const refsPane = collapsiblePane('toggle-refs', 'refs-pane');
const filesPane = collapsiblePane('toggle-files', 'commit-files', document.getElementById('diff-files'));
const state = vscode.getState();
const expansion = new Map(state?.expansion ?? []);
const tagQueries = new Map(state?.tagQueries ?? []);
let selected = state?.selected;
let selectedButton;
const repositories = new Map();
let commitRequest;

function collapsiblePane(buttonId, bodyId, scrollElement) {
  const button = document.getElementById(buttonId);
  const body = document.getElementById(bodyId);
  const scroll = scrollElement ?? body;
  let scrollTop = 0;

  function setExpanded(expanded) {
    if (expanded === !body.hidden) return;
    if (!expanded) scrollTop = scroll.scrollTop;
    body.hidden = !expanded;
    body.parentElement.classList.toggle('expanded', expanded);
    button.setAttribute('aria-expanded', String(expanded));
    if (expanded) scroll.scrollTop = scrollTop;
  }

  button.addEventListener('click', () => setExpanded(body.hidden));
  return { setExpanded };
}

function saveState() {
  vscode.setState({ expansion: [...expansion], selected, tagQueries: [...tagQueries] });
}

function rowText(row, label) {
  const name = document.createElement('span');
  name.className = 'label';
  name.textContent = label;
  row.append(name);
}

function disclosure(key, label, defaultOpen = false, searching = false) {
  const node = document.createElement('details');
  node.open = searching || (expansion.get(key) ?? defaultOpen);
  const summary = document.createElement('summary');
  summary.className = 'row disclosure';
  summary.dataset.key = key;
  const arrow = document.createElement('span');
  arrow.className = 'ref-disclosure';
  arrow.setAttribute('aria-hidden', 'true');
  summary.append(arrow);
  rowText(summary, label);
  const content = document.createElement('div');
  content.className = 'children';
  node.append(summary, content);
  node.addEventListener('toggle', () => {
    if (searching || !node.isConnected || node.open === (expansion.get(key) ?? defaultOpen)) return;
    if (node.open === defaultOpen) expansion.delete(key);
    else expansion.set(key, node.open);
    saveState();
  });
  return { node, summary, content, arrow };
}

function fetchToolbar(root) {
  const bar = document.createElement('div');
  bar.className = 'fetch-toolbar';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fetch-button';
  button.dataset.key = JSON.stringify([root, 'fetch']);
  button.setAttribute('aria-label', 'Fetch all remotes and tags');
  button.title = 'git fetch --all --tags';
  button.addEventListener('click', () => vscode.postMessage({ type: 'fetch', root }));
  const icon = document.createElement('span');
  icon.className = 'fetch-icon';
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  bar.append(button);
  return bar;
}

function setCheckedBranches(repository, names, checked) {
  for (const name of names) {
    if (checked) repository.checkedBranches.add(name);
    else repository.checkedBranches.delete(name);
  }
}

function setBranchChecked(checkbox, checked) {
  checkbox.checked = checked;
  const button = checkbox.nextElementSibling;
  button.disabled = !checked;
  if (!checked && selectedButton === button) {
    button.removeAttribute('aria-current');
    selectedButton = undefined;
    selected = undefined;
    saveState();
  }
}

function groupCheckbox(repository, group, content) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'branch-group-checkbox';
  checkbox.dataset.key = JSON.stringify([repository.root, 'filterGroup', group.id]);
  checkbox.setAttribute('aria-label', `Show all ${group.label} branches in the commit graph`);
  const branches = Array.from(content?.querySelectorAll('input[data-branch]') ?? []);
  checkbox.disabled = !branches.length;
  if (checkbox.disabled) return checkbox;

  const sync = () => {
    checkbox.checked = branches.every(input => input.checked);
    checkbox.indeterminate = !checkbox.checked && branches.some(input => input.checked);
  };
  sync();
  content.addEventListener('change', sync);
  checkbox.addEventListener('click', event => event.stopPropagation());
  checkbox.addEventListener('change', () => {
    const checked = checkbox.checked;
    for (const input of branches) setBranchChecked(input, checked);
    setCheckedBranches(repository, branches.map(input => input.dataset.branch), checked);
    sync();
    vscode.postMessage({ type: 'filterBranchGroup', root: repository.root, group: group.id, checked });
  });
  return checkbox;
}

function branchDivergence({ upstream, ahead, behind }) {
  if (!ahead && !behind) return;
  const indicator = document.createElement('span');
  indicator.className = 'branch-divergence';
  indicator.setAttribute('aria-hidden', 'true');
  const distances = [];
  for (const [direction, count] of [['ahead', ahead], ['behind', behind]]) {
    if (!count) continue;
    const badge = document.createElement('span');
    badge.className = `branch-distance ${direction}`;
    badge.textContent = count;
    indicator.append(badge);
    distances.push(`${count} ${count === 1 ? 'commit' : 'commits'} ${direction}`);
  }
  indicator.title = `${distances.join(', ')} compared with ${upstream.slice('refs/remotes/'.length)}`;
  return indicator;
}

function updateLocalTagBadge(button, localOnly) {
  const badge = button.querySelector('.local-only-tag');
  if (localOnly === Boolean(badge)) return;
  if (localOnly) {
    const indicator = document.createElement('span');
    indicator.className = 'local-only-tag';
    indicator.setAttribute('aria-hidden', 'true');
    button.append(indicator);
    button.title += '\nLocal only';
    button.setAttribute('aria-label', `${button.dataset.tag.slice('refs/tags/'.length)}, local only`);
  } else {
    badge.remove();
    button.title = button.title.slice(0, -'\nLocal only'.length);
    button.removeAttribute('aria-label');
  }
}

function refNode(repository, group, parent, { label, ref, children }, searching = false) {
  const { root } = repository;
  const path = [...parent, label];
  const key = JSON.stringify([root, group, ...path]);
  if (!ref) {
    const folder = disclosure(key, label, false, searching);
    folder.content.append(...children.map(child => refNode(repository, group, path, child, searching)));
    return folder.node;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row ref';
  button.disabled = group !== 'tags' && !repository.checkedBranches.has(ref.fullName);
  button.dataset.key = key;
  button.title = [ref.name, ref.current && 'Current branch', ref.author && `${ref.authorSource}: ${ref.author}`]
    .filter(Boolean).join('\n');
  rowText(button, ref.current ? `✓ ${label}` : label);
  const divergence = group === 'heads' && branchDivergence(ref);
  if (divergence) {
    button.append(divergence);
    button.title += `\n${divergence.title}`;
    button.setAttribute('aria-label', [ref.name, ref.current && 'Current branch', divergence.title].filter(Boolean).join(', '));
  }
  if (!button.disabled && selected === key) {
    button.setAttribute('aria-current', 'true');
    selectedButton = button;
  }
  button.addEventListener('click', () => {
    if (button.disabled) return;
    selectedButton?.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    selectedButton = button;
    selected = key;
    saveState();
    vscode.postMessage({ type: 'revealRef', root, fullName: ref.fullName });
  });
  const context = { root, fullName: ref.fullName, preventDefaultContextMenuItems: true };
  if (group === 'tags') {
    button.dataset.tag = ref.fullName;
    if (repository.localOnlyTags.has(ref.fullName)) updateLocalTagBadge(button, true);
    button.dataset.vscodeContext = JSON.stringify({ ...context, webviewSection: 'tag' });
    return button;
  }

  const row = document.createElement('div');
  row.className = 'branch-row';
  row.dataset.vscodeContext = JSON.stringify({
    ...context,
    webviewSection: group === 'heads' ? 'localBranch' : 'remoteBranch',
    gitPlusPlusBranchCurrent: ref.current,
  });
  row.title = button.title;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.key = JSON.stringify([root, 'filter', ref.fullName]);
  checkbox.dataset.branch = ref.fullName;
  checkbox.setAttribute('aria-label', `Show ${ref.name} in the commit graph`);
  checkbox.checked = !button.disabled;
  checkbox.addEventListener('change', () => {
    const checked = checkbox.checked;
    setBranchChecked(checkbox, checked);
    setCheckedBranches(repository, [ref.fullName], checked);
    vscode.postMessage({ type: 'filterBranch', root, fullName: ref.fullName, checked });
  });
  row.append(checkbox, button);
  return row;
}

function matchingTags(nodes, pattern) {
  const matches = [];
  for (const node of nodes) {
    if (node.ref) {
      if (pattern.test(node.ref.name)) matches.push(node);
    } else {
      const children = matchingTags(node.children, pattern);
      if (children.length) matches.push({ ...node, children });
    }
  }
  return matches;
}

function renderRefs(container, repository, group, children, searching = false) {
  if (children.length) {
    container.replaceChildren(...children.map(child => refNode(repository, group.id, [], child, searching)));
  } else {
    const empty = document.createElement('div');
    empty.className = 'row ref-group-empty';
    empty.textContent = 'None';
    container.replaceChildren(empty);
  }
}

function renderTagGroup(content, repository, group) {
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'tag-search';
  search.placeholder = 'Search tags (regex)';
  search.setAttribute('aria-label', 'Search tags by regular expression');
  search.dataset.key = JSON.stringify([repository.root, 'tagSearch']);
  search.value = tagQueries.get(repository.root) ?? '';

  const message = document.createElement('div');
  message.className = 'row tag-search-status';
  message.setAttribute('role', 'status');
  const results = document.createElement('div');
  content.append(search, message, results);
  let lastPattern;
  let searchTimer;

  function update() {
    let pattern;
    try {
      if (search.value) pattern = new RegExp(search.value);
    } catch {
      search.setAttribute('aria-invalid', 'true');
    }
    const invalid = Boolean(search.value && !pattern);
    if (!invalid) search.removeAttribute('aria-invalid');
    const source = pattern?.source ?? '';
    if (source === lastPattern) {
      if (!pattern) message.textContent = invalid ? 'Invalid regular expression' : '';
      return;
    }
    lastPattern = source;
    const children = pattern ? matchingTags(group.children, pattern) : group.children;
    const noMatches = Boolean(pattern && !children.length);
    message.textContent = invalid ? 'Invalid regular expression' : noMatches ? 'No matching tags' : '';
    if (results.contains(selectedButton ?? null)) selectedButton = undefined;
    if (noMatches) results.replaceChildren();
    else renderRefs(results, repository, group, children, Boolean(pattern));
  }

  search.addEventListener('input', () => {
    if (search.value) tagQueries.set(repository.root, search.value);
    else tagQueries.delete(repository.root);
    saveState();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (search.isConnected) update();
    }, 120);
  });
  update();
}

function refGroup(repository, group) {
  const section = disclosure(JSON.stringify([repository.root, group.id]), group.label, group.id === 'heads');
  section.node.className = 'ref-group';
  if (group.id === 'tags') {
    renderTagGroup(section.content, repository, group);
  } else {
    renderRefs(section.content, repository, group, group.children);
    section.arrow.after(groupCheckbox(repository, group, section.content));
  }
  return section.node;
}

function repositoryNode(repository) {
  const { root, label, groups, error } = repository;
  const repo = disclosure(JSON.stringify([root]), label, true);
  repo.node.className = 'repository';
  repo.summary.title = root;
  repo.summary.dataset.vscodeContext = JSON.stringify({ webviewSection: 'repository', root });
  repo.content.append(fetchToolbar(root));
  if (error) {
    const message = document.createElement('p');
    message.className = 'hint';
    message.textContent = error;
    repo.content.append(message);
    return repo.node;
  }
  repo.content.append(...groups.map(group => refGroup(repository, group)));
  return repo.node;
}

function renderRepository(repository) {
  const previous = repositories.get(repository.root)?.node;
  const focused = document.activeElement;
  const focusedKey = previous?.contains(focused) ? focused.dataset.key : undefined;
  if (previous?.contains(selectedButton ?? null)) selectedButton = undefined;
  const node = repositoryNode(repository);
  repositories.set(repository.root, { repository, node });
  if (previous) previous.replaceWith(node);
  else list.append(node);
  if (focusedKey) {
    const next = [...node.querySelectorAll('[data-key]')].find(candidate => candidate.dataset.key === focusedKey);
    next?.focus({ preventScroll: true });
    if (focused.type === 'search') next?.setSelectionRange(focused.selectionStart, focused.selectionEnd, focused.selectionDirection);
  }
}

function updateRepositories({ repositories: updated, roots, emptyMessage }) {
  const activeRoots = new Set(roots);
  for (const [root, { node }] of repositories) {
    if (activeRoots.has(root)) continue;
    if (node.contains(selectedButton ?? null)) selectedButton = undefined;
    node.remove();
    repositories.delete(root);
  }
  for (const repository of updated) {
    if (!activeRoots.has(repository.root)) continue;
    repository.checkedBranches = new Set(repository.checkedBranches);
    repository.localOnlyTags = new Set(repository.localOnlyTags);
    renderRepository(repository);
  }
  let next = null;
  for (let index = roots.length - 1; index >= 0; index--) {
    const node = repositories.get(roots[index])?.node;
    if (!node) continue;
    if (node.nextElementSibling !== next) list.insertBefore(node, next);
    next = node;
  }
  status.hidden = repositories.size > 0;
  status.textContent = repositories.size ? '' : emptyMessage ?? (roots.length ? 'Loading Git repositories...' :
    'Open a Git repository to browse branches, tags, and commits.');
}

window.addEventListener('message', ({ data }) => {
  if (data?.type === 'commitFiles') {
    const request = data.commit?.request;
    if (request !== commitRequest) {
      const showFiles = request !== undefined;
      refsPane.setExpanded(!showFiles);
      filesPane.setExpanded(showFiles);
      commitRequest = request;
    }
    changedFiles.show(data.commit);
  } else if (data?.type === 'changedFilesMode') {
    changedFiles.setMode(data.mode);
  } else if (data?.type === 'repositories') {
    updateRepositories(data);
  } else if (data?.type === 'localOnlyTags') {
    const entry = repositories.get(data.root);
    if (entry) {
      const { repository, node } = entry;
      const names = new Set(data.names);
      const before = repository.localOnlyTags;
      if (before.size === names.size && data.names.every(name => before.has(name))) return;
      repository.localOnlyTags = names;
      for (const button of node.querySelectorAll('[data-tag]')) {
        const name = button.dataset.tag;
        if (before.has(name) !== names.has(name)) updateLocalTagBadge(button, names.has(name));
      }
    }
  } else if (data?.type === 'branchSelection') {
    const repository = repositories.get(data.root)?.repository;
    if (repository) {
      const before = repository.checkedBranches;
      if (before.size !== data.checkedBranches.length || data.checkedBranches.some(name => !before.has(name))) {
        repository.checkedBranches = new Set(data.checkedBranches);
        renderRepository(repository);
      }
    }
  }
});

vscode.postMessage({ type: 'ready' });
