'use strict';

const lanePalette = [
  '--vscode-charts-blue', '--vscode-charts-orange', '--vscode-charts-green',
  '--vscode-charts-purple', '--vscode-charts-red', '--vscode-charts-yellow',
];

function unnamedLaneColor(hash) {
  let index = 0;
  for (let i = 0; i < hash.length; i++) index = (index * 31 + hash.charCodeAt(i)) >>> 0;
  return `var(${lanePalette[index % lanePalette.length]})`;
}

function layoutGraph(commits, refs = [], scopeColor, firstParent = false, mergesOnly = false) {
  const visible = mergesOnly ? new Set(commits.map(commit => commit.hash)) : undefined;
  return graphLayout(refs, scopeColor, firstParent, visible)(commits);
}

function graphLayout(refs, scopeColor, firstParent, visible, missingParents) {
  const tipColors = new Map();
  for (const { hash, color } of refs) {
    if (hash && color && !tipColors.has(hash)) tipColors.set(hash, color);
  }
  let lanes = [];
  let atStart = true;
  return commits => commits.map(commit => {
    if (atStart && scopeColor && !tipColors.has(commit.hash)) tipColors.set(commit.hash, scopeColor);
    atStart = false;
    const incoming = [...lanes];
    let column = lanes.findIndex(lane => lane.hash === commit.hash);
    if (column < 0) {
      column = lanes.length;
      lanes.push({ hash: commit.hash, color: tipColors.get(commit.hash) ?? unnamedLaneColor(commit.hash) });
    }
    const current = lanes[column];
    const continuing = lanes.filter(lane => lane !== current);
    const pending = new Map(continuing.map(lane => [lane.hash, lane]));
    const added = [];
    const parentHashes = firstParent ? commit.parents.slice(0, 1) : commit.parents;
    const parents = [];
    for (const [index, hash] of parentHashes.entries()) {
      if (visible && !visible.has(hash)) {
        missingParents?.add(hash);
        continue;
      }
      if (!pending.has(hash)) {
        const color = tipColors.get(hash) ?? (index === 0 ? current.color : unnamedLaneColor(hash));
        const lane = { hash, color };
        pending.set(hash, lane);
        added.push(lane);
      }
      parents.push(pending.get(hash));
    }
    const outgoing = [...continuing.slice(0, column), ...added, ...continuing.slice(column)];
    const destination = new Map(outgoing.map((lane, index) => [lane, index]));
    const edges = lanes.flatMap((lane, from) => {
      if (lane === current) {
        return parents.map(parent => ({
          from, to: destination.get(parent), color: parent.color,
        }));
      }
      return [{ from, to: destination.get(lane), color: lane.color }];
    });
    const width = Math.max(lanes.length, outgoing.length);
    lanes = outgoing;
    return { incoming, column, color: current.color, edges, width };
  });
}

function enableColumnResize(table, vscode) {
  const headers = Array.from(table.tHead.rows[0].cells);
  const columns = table.querySelectorAll('col');
  const sizes = [
    { key: 'graph', width: 100, min: 52 },
    { key: 'message', width: null, min: 100 },
    { key: 'author', width: 70, min: 70 },
    { key: 'time', width: 150, min: 125 },
    { key: 'hash', width: 90, min: 68 },
  ];
  const messageIndex = sizes.findIndex(({ key }) => key === 'message');
  const saved = vscode.getState()?.columnWidths;
  const savedByColumn = Array.isArray(saved)
    ? { graph: saved[0], message: saved[1], author: saved[2], time: saved[3], hash: saved[4] }
    : saved;
  const overrides = sizes.map(({ key, min }) => {
    const width = savedByColumn?.[key];
    return Number.isFinite(width) && width > 0 ? Math.max(min, width) : null;
  });

  function applyWidths() {
    const widths = sizes.map(({ width }, index) => overrides[index] ?? width);
    let total = 1;
    columns.forEach((column, index) => {
      const width = widths[index];
      column.style.width = width === null ? '' : `${width}px`;
      total += width ?? sizes[index].min;
    });
    const tableWidth = `${total}px`;
    table.style.minWidth = tableWidth;
    table.style.width = widths.includes(null) ? '' : tableWidth;
  }

  headers.forEach((header, index) => {
    const { width: defaultWidth, min } = sizes[index];
    const handle = document.createElement('span');
    handle.className = 'column-resize';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize ${header.textContent.trim()} column`);
    header.append(handle);
    let drag;

    const currentWidth = () => Math.round(header.getBoundingClientRect().width);
    function announceWidth(width = currentWidth()) {
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuenow', String(width));
    }
    function resize(width) {
      const resized = Math.max(min, Math.round(width));
      if (overrides[messageIndex] === null) {
        if (resized === currentWidth()) return;
        if (index !== messageIndex) {
          // Keep the current message width when switching from fill to fixed table width.
          overrides[messageIndex] = Math.round(headers[messageIndex].getBoundingClientRect().width);
        }
      }
      overrides[index] = resized === defaultWidth ? null : resized;
      applyWidths();
      announceWidth(resized);
    }
    function saveWidths() {
      const columnWidths = Object.fromEntries(sizes.map(({ key }, index) => [key, overrides[index]]));
      vscode.setState({ ...vscode.getState(), columnWidths });
    }

    handle.addEventListener('focus', () => announceWidth());
    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, width: currentWidth() };
      handle.setPointerCapture(event.pointerId);
      table.classList.add('resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) {
        const delta = event.clientX - drag.x;
        if (delta || drag.changed) {
          resize(drag.width + delta);
          drag.changed = true;
        }
      }
    });
    handle.addEventListener('lostpointercapture', () => {
      if (drag?.changed) saveWidths();
      drag = undefined;
      table.classList.remove('resizing');
    });
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      resize(currentWidth() + (event.key === 'ArrowLeft' ? -12 : 12));
      saveWidths();
    });
  });

  applyWidths();
}

function nextDiffSelection(hashes, hash, compare) {
  if (!compare) return hashes.length === 1 && hashes[0] === hash ? [] : [hash];
  if (hashes.includes(hash)) return hashes.filter(selected => selected !== hash);
  return hashes.length ? [hashes[0], hash] : [hash];
}

function setupCommitAction(vscode) {
  const dialog = document.getElementById('commit-action');
  const form = dialog.querySelector('form');
  const fields = form.querySelector('fieldset');
  const nameField = document.getElementById('commit-action-name-field');
  const tagFields = document.getElementById('commit-action-tag-fields');
  const messageField = document.getElementById('commit-action-message-field');
  const checkoutFields = document.getElementById('commit-action-checkout-fields');
  const parentField = document.getElementById('commit-action-parent-field');
  const description = document.getElementById('commit-action-description');
  const error = document.getElementById('commit-action-error');
  const { name, tagType, tagMessage, merge, submodules, mainline } = form.elements;
  const apply = form.querySelector('[value="apply"]');
  const checkout = form.querySelector('[value="checkout"]');
  const cancel = form.querySelector('[value="cancel"]');
  const actions = {
    branch: { title: 'Create Branch', button: 'Create' },
    tag: { title: 'Add Tag' },
    checkout: { title: 'Checkout', description: 'Leave the branch name blank to check out this commit in detached HEAD mode.' },
    revert: { title: 'Revert', description: 'Create a commit that reverses these changes on the current HEAD.' },
    cherryPick: { title: 'Cherry-pick', description: 'Apply these changes as a new commit on the current HEAD.' },
  };
  let request;

  function setRunning(running) {
    fields.disabled = apply.disabled = checkout.disabled = cancel.disabled = running;
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function updateTagMessage() {
    const visible = !tagFields.hidden && tagType.value !== 'lightweight';
    messageField.hidden = !visible;
    tagMessage.required = visible;
  }

  function dismiss() {
    const cancelled = request;
    request = undefined;
    dialog.close();
    vscode.postMessage({ type: 'cancelCommitAction', request: cancelled });
  }

  for (const option of tagType) option.addEventListener('change', updateTagMessage);
  cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!cancel.disabled) dismiss();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (request === undefined || apply.disabled) return;
    showError('');
    setRunning(true);
    vscode.postMessage({
      type: 'submitCommitAction', request,
      options: {
        name: name.value, tagType: tagType.value, tagMessage: tagMessage.value,
        merge: merge.checked, submodules: submodules.checked, mainline: Number(mainline.value),
        checkout: event.submitter === checkout,
      },
    });
  });

  return data => {
    if (data.type === 'showCommitAction') {
      const { title, button, description: detail } = actions[data.action];
      const { action, commit } = data;
      request = data.request;
      form.reset();
      setRunning(false);
      showError('');
      document.getElementById('commit-action-title').textContent = title;
      const target = document.getElementById('commit-action-target');
      target.textContent = `${commit.shortHash} · ${commit.subject || '(No commit message)'}`;
      target.title = target.textContent;
      description.textContent = detail ?? '';
      description.hidden = !detail;
      nameField.hidden = !['branch', 'tag', 'checkout'].includes(action);
      nameField.firstElementChild.textContent = action === 'checkout' ? 'New branch name (optional)' : 'Name';
      name.required = action === 'branch' || action === 'tag';
      tagFields.hidden = action !== 'tag';
      updateTagMessage();
      checkoutFields.hidden = action !== 'checkout';
      checkout.hidden = action !== 'branch';
      apply.textContent = button ?? title;
      const chooseParent = (action === 'revert' || action === 'cherryPick') && commit.parents.length > 1;
      parentField.hidden = !chooseParent;
      mainline.required = chooseParent;
      mainline.replaceChildren();
      if (chooseParent) {
        mainline.append(new Option('Select a parent', '', true, true));
        commit.parents.forEach((parent, index) => {
          mainline.append(new Option(`Parent ${index + 1} · ${parent.slice(0, 8)}`, String(index + 1)));
        });
      }
      if (!dialog.open) dialog.showModal();
      if (!nameField.hidden) name.focus();
      else if (chooseParent) mainline.focus();
      else cancel.focus();
    } else if (request === data.request) {
      if (data.type === 'closeCommitAction') {
        request = undefined;
        dialog.close();
      } else {
        setRunning(false);
        showError(data.message);
      }
    }
  };
}

function startWebview() {
  const vscode = acquireVsCodeApi();
  const handleCommitAction = setupCommitAction(vscode);
  const graphScroll = document.getElementById('graph-scroll');
  const searchInput = document.getElementById('commit-search');
  const historyFilters = {
    firstParent: document.getElementById('first-parent'),
    mergesOnly: document.getElementById('merges-only'),
  };
  const searchStatus = document.getElementById('search-status');
  const scope = document.getElementById('scope');
  const status = document.getElementById('status');
  const history = document.getElementById('history');
  const table = document.getElementById('commit-table');
  const tbody = document.getElementById('commits');
  const pagination = document.getElementById('pagination');
  const pageLoading = document.getElementById('page-loading');
  const tagTooltip = document.getElementById('tag-tooltip');
  const all = document.getElementById('all');
  const refresh = document.getElementById('refresh');
  enableColumnResize(table, vscode);
  let selection;
  let revealAnimations = [];
  let diffHashes = [];
  let rows = new Map();
  let renderedCommits = [];
  let renderedHistory;
  let renderedRefsKey;
  let labels;
  let layout;
  let visibleMergeHashes;
  let missingMergeParents;
  let nextPage;
  let tooltipTarget;
  let historyPage;
  let searchTimer;
  let searchRequest = 0;
  let searchPending = false;
  let lastMatch;
  let searchAfter;
  let commitContext;

  const message = type => vscode.postMessage({ type });
  for (const [type, checkbox] of Object.entries(historyFilters)) {
    checkbox.addEventListener('change', () => {
      historyPage = undefined;
      lastMatch = undefined;
      resetSearch();
      vscode.postMessage({ type, checked: checkbox.checked, commitContext });
    });
  }
  all.addEventListener('click', () => message('all'));
  refresh.addEventListener('click', () => message('refresh'));
  searchInput.addEventListener('input', event => {
    if (!event.isComposing) searchFromFirst();
  });
  searchInput.addEventListener('compositionend', searchFromFirst);
  searchInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
    event.preventDefault();
    if (!searchPending || !lastMatch) scheduleSearch(lastMatch, 0);
  });
  graphScroll.addEventListener('scroll', hideTagTooltip, { passive: true });
  window.addEventListener('resize', hideTagTooltip);

  function resetSearch() {
    clearTimeout(searchTimer);
    searchRequest++;
    searchPending = false;
    searchAfter = undefined;
    searchStatus.textContent = '';
  }

  function searchFromFirst() {
    lastMatch = undefined;
    scheduleSearch();
  }

  function scheduleSearch(after, delay = 180) {
    resetSearch();
    message('cancelSearch');
    const query = searchInput.value.trim();
    if (!query) return;
    searchPending = true;
    searchAfter = after;
    searchStatus.textContent = 'Searching...';
    if (historyPage === undefined) return;
    const page = historyPage;
    const request = searchRequest;
    searchTimer = setTimeout(() => {
      if (page === historyPage && request === searchRequest) {
        vscode.postMessage({ type: 'search', query, request, page, after });
      }
    }, delay);
  }

  function hideTagTooltip() {
    tagTooltip.hidden = true;
    tooltipTarget = undefined;
  }

  function resetDiffSelection() {
    if (diffHashes.includes(selection)) setSelected(undefined);
    setDiffHashes([]);
  }

  function closeDiff(closeFileDiff = false) {
    if (!diffHashes.length) return;
    resetDiffSelection();
    vscode.postMessage({ type: 'cancelDiff', closeFileDiff });
  }

  function toggleDiff(commit, compare) {
    const hashes = nextDiffSelection(diffHashes, commit.hash, compare);
    if (!hashes.length) {
      closeDiff(true);
      return;
    }
    setDiffHashes(hashes);
    setSelected(hashes.at(-1));
    const [hash, compareWith] = hashes;
    vscode.postMessage({ type: 'previewDiff', hash, compareWith });
  }

  function setDiffHashes(hashes) {
    for (const hash of diffHashes) rows.get(hash)?.classList.remove('diff-selected');
    diffHashes = hashes;
    for (const hash of hashes) rows.get(hash)?.classList.add('diff-selected');
  }

  function addTagTooltip(label, ref, commitDate) {
    label.tabIndex = 0;
    label.setAttribute('aria-describedby', tagTooltip.id);
    const author = ref.tagger || '—';
    const publishDate = ref.taggerDate || commitDate;
    const publish = publishDate ? formatCommitTime(publishDate, '') : '—';
    function show() {
      const gap = 8;
      const { left, top, bottom } = label.getBoundingClientRect();
      tooltipTarget = label;
      tagTooltip.textContent = `author: ${author}\npublish: ${publish}`;
      tagTooltip.hidden = false;
      const { offsetWidth, offsetHeight } = tagTooltip;
      const { clientWidth, clientHeight } = document.documentElement;
      const below = bottom + gap;
      const y = below + offsetHeight <= clientHeight - gap ? below : top - offsetHeight - gap;
      tagTooltip.style.left = `${Math.max(gap, Math.min(left, clientWidth - offsetWidth - gap))}px`;
      tagTooltip.style.top = `${Math.max(gap, y)}px`;
    }
    function hide() {
      if (tooltipTarget === label) hideTagTooltip();
    }
    label.addEventListener('mouseenter', show);
    label.addEventListener('mouseleave', hide);
    label.addEventListener('focus', show);
    label.addEventListener('blur', hide);
    label.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  }

  const bottomObserver = new IntersectionObserver(entries => {
    if (nextPage === undefined || !entries.some(entry => entry.isIntersecting)) return;
    const page = nextPage;
    nextPage = undefined;
    bottomObserver.disconnect();
    pageLoading.hidden = false;
    vscode.postMessage({ type: 'more', page });
  }, { root: graphScroll, rootMargin: '0px 0px 180px 0px' });

  function svgElement(name, attributes) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  const laneX = index => 12 + index * 15;
  const laneWidth = columns => laneX(columns - 1) + 12;

  function formatCommitTime(value, dateSeparator = '-') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const year = String(date.getFullYear()).padStart(4, '0');
    const twoDigits = number => String(number).padStart(2, '0');
    const day = [year, twoDigits(date.getMonth() + 1), twoDigits(date.getDate())].join(dateSeparator);
    return `${day} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  }

  function drawGraph(layout) {
    const width = laneWidth(layout.width);
    const center = 17;
    const node = svgElement('svg', { class: 'lane-node', width, height: 23, 'aria-hidden': 'true' });
    const tail = svgElement('svg', {
      class: 'lane-tail', width, viewBox: `0 0 ${width} 16`, preserveAspectRatio: 'none', 'aria-hidden': 'true',
    });
    function edge(svg, d, color) {
      svg.append(svgElement('path', { d, stroke: color }));
    }
    layout.incoming.forEach((lane, index) => edge(node, `M ${laneX(index)} 0 V ${center}`, lane.color));
    for (const { from, to, color } of layout.edges) {
      edge(tail, `M ${laneX(from)} 0 C ${laneX(from)} 8 ${laneX(to)} 8 ${laneX(to)} 16`, color);
    }
    node.append(svgElement('circle', {
      cx: laneX(layout.column), cy: center, r: 4.4,
      fill: layout.color,
    }));
    return [tail, node];
  }

  function setSelected(hash) {
    const previous = rows.get(selection);
    previous?.removeAttribute('aria-current');
    previous?.classList.remove('selected');
    selection = hash;
    const row = rows.get(hash);
    row?.setAttribute('aria-current', 'true');
    row?.classList.add('selected');
  }

  function revealCommit(hash, flash = false) {
    const row = rows.get(hash);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    for (const animation of revealAnimations) animation.cancel();
    revealAnimations = [];
    if (!flash || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const backgroundColor = 'var(--vscode-editor-findMatchHighlightBackground, var(--vscode-list-hoverBackground))';
    revealAnimations = Array.from(row.cells, cell => cell.animate([
      { offset: 0.2, backgroundColor },
      { offset: 0.55, backgroundColor },
    ], { duration: 420, iterations: 2 }));
  }

  function render(data) {
    const append = data.offset !== undefined;
    const refsKey = append ? renderedRefsKey : JSON.stringify(data.refs);
    const reuseRows = append ? !data.commits.some(commit => missingMergeParents?.has(commit.hash))
      : !data.resetScroll && !data.mergesOnly && data.firstParent === renderedHistory?.firstParent &&
        data.mergesOnly === renderedHistory?.mergesOnly && data.scopeColor === renderedHistory?.scopeColor &&
        refsKey === renderedRefsKey && renderedCommits.length <= data.commits.length &&
        renderedCommits.every(({ hash, parents }, index) => {
          const next = data.commits[index];
          return hash === next.hash && parents.length === next.parents.length &&
            parents.every((parent, position) => parent === next.parents[position]);
        });
    const start = reuseRows ? renderedCommits.length : 0;
    if (append) {
      for (const commit of data.commits) renderedCommits.push(commit);
    } else {
      renderedCommits = data.commits;
      renderedHistory = data;
      renderedRefsKey = refsKey;
    }
    const commits = renderedCommits;
    if (data.resetScroll || (!append && diffHashes.some(hash => !commits.some(commit => commit.hash === hash)))) closeDiff();
    if (data.resetScroll) {
      graphScroll.scrollTo(0, 0);
      selection = undefined;
    }
    if (!reuseRows) {
      hideTagTooltip();
      rows = new Map();
      labels = new Map();
      for (const ref of renderedHistory.refs) {
        if (!ref.hash) continue;
        if (!labels.has(ref.hash)) labels.set(ref.hash, []);
        labels.get(ref.hash).push(ref);
      }
      // A newly visible merge parent can change the connections in earlier rows.
      visibleMergeHashes = data.mergesOnly ? new Set(commits.map(commit => commit.hash)) : undefined;
      missingMergeParents = data.mergesOnly ? new Set() : undefined;
      layout = graphLayout(renderedHistory.refs, renderedHistory.scopeColor, data.firstParent, visibleMergeHashes, missingMergeParents);
    } else if (visibleMergeHashes) {
      for (const commit of data.commits) visibleMergeHashes.add(commit.hash);
    }
    const added = commits.slice(start);
    const layouts = layout(added);
    const contents = document.createDocumentFragment();
    added.forEach((commit, offset) => {
      const index = start + offset;
      const refs = labels.get(commit.hash);
      const row = document.createElement('tr');
      if (refs) row.classList.add('has-refs');
      const graph = row.insertCell();
      graph.className = 'lane';
      const number = document.createElement('span');
      number.className = 'row-number';
      number.textContent = String(index + 1);
      graph.addEventListener('click', event => toggleDiff(commit, event.metaKey));
      graph.append(number, ...drawGraph(layouts[offset]));
      const summary = row.insertCell();
      summary.className = 'summary';
      summary.dataset.vscodeContext = JSON.stringify({
        webviewSection: 'commit', commitContext: renderedHistory.commitContext, hash: commit.hash,
        preventDefaultContextMenuItems: true,
      });
      const message = document.createElement('span');
      message.className = 'subject';
      message.textContent = commit.subject || '(No commit message)';
      message.title = `${message.textContent}\n${commit.hash}`;
      summary.append(message);
      if (refs) {
        const decorations = document.createElement('div');
        decorations.className = 'ref-list';
        for (const ref of refs) {
          const label = document.createElement('span');
          label.className = `ref ${ref.group}`;
          if (ref.color) label.style.setProperty('--branch-color', ref.color);
          if (ref.current && ref.group === 'heads') label.classList.add('current-branch');
          label.textContent = ref.current ? `✓ ${ref.name}` : ref.name;
          if (ref.group === 'tags') addTagTooltip(label, ref, commit.date);
          else label.title = ref.fullName;
          decorations.append(label);
        }
        summary.append(decorations);
      }

      const author = row.insertCell();
      author.className = 'author';
      author.textContent = commit.author || '—';
      if (commit.author) author.title = commit.author;
      const date = row.insertCell();
      date.className = 'date';
      const time = document.createElement('time');
      time.dateTime = commit.date;
      time.textContent = formatCommitTime(commit.date);
      time.title = commit.date;
      date.append(time);
      const hash = row.insertCell();
      hash.className = 'hash';
      const shortHash = document.createElement('code');
      shortHash.textContent = commit.shortHash;
      shortHash.title = commit.hash;
      hash.append(shortHash);
      rows.set(commit.hash, row);
      contents.append(row);
    });
    if (reuseRows) tbody.append(contents);
    else tbody.replaceChildren(contents);
    scope.textContent = renderedHistory.scope ?? '';
    scope.title = renderedHistory.scope ?? '';
    all.hidden = !renderedHistory.scope;
    status.textContent = renderedHistory.warning ?? (commits.length ? '' : renderedHistory.emptyMessage);
    status.hidden = !status.textContent;
    history.hidden = !commits.length;
    pageLoading.hidden = true;
    nextPage = data.hasMore && commits.length ? data.page : undefined;
    pagination.hidden = nextPage === undefined;
    if (!reuseRows) setDiffHashes(diffHashes);
    if (data.revealHash || data.resetScroll) setSelected(data.selected);
    else if (!reuseRows) setSelected(selection);
    if (data.revealHash) revealCommit(data.revealHash, !data.selected);
    bottomObserver.disconnect();
    if (nextPage !== undefined) bottomObserver.observe(pagination);
  }

  window.addEventListener('message', ({ data }) => {
    if (Object.hasOwn(historyFilters, data.type)) {
      commitContext = data.commitContext;
      const checkbox = historyFilters[data.type];
      checkbox.checked = data.checked;
      checkbox.disabled = false;
      return;
    }
    if (['showCommitAction', 'closeCommitAction', 'commitActionError'].includes(data.type)) {
      handleCommitAction(data);
      return;
    }
    if (data.type === 'history' && Object.entries(historyFilters).some(([type, checkbox]) => data[type] !== checkbox.checked)) return;
    if (data.type === 'searchResult') {
      if (data.request !== searchRequest || data.page !== historyPage) return;
      searchPending = false;
      searchStatus.textContent = data.error ?? (data.hash ? '' : 'No matching commits');
      if (!data.error) lastMatch = data.hash;
      if (data.hash) {
        setSelected(data.hash);
        revealCommit(data.hash);
      }
      return;
    }
    const loading = data.type === 'loading';
    refresh.disabled = loading;
    all.disabled = loading;
    if (loading) {
      historyPage = undefined;
      nextPage = undefined;
      bottomObserver.disconnect();
      pageLoading.hidden = !data.paging;
      if (data.resetHistory) {
        closeDiff();
        hideTagTooltip();
        history.hidden = true;
      }
      if (history.hidden) {
        status.textContent = 'Loading commit history...';
        status.hidden = false;
      }
    } else if (data.type === 'history') {
      if (data.offset !== undefined && (!renderedHistory || data.offset !== renderedCommits.length)) return;
      const newPage = data.page !== historyPage;
      historyPage = data.page;
      render(data);
      if (newPage) {
        if (data.revealHash) {
          lastMatch = undefined;
          resetSearch();
        } else if (data.resetScroll && searchInput.value.trim()) {
          searchFromFirst();
        } else if (searchPending) {
          scheduleSearch(searchAfter, 0);
        }
      }
    } else if (data.type === 'error') {
      resetSearch();
      closeDiff();
      hideTagTooltip();
      history.hidden = true;
      status.textContent = data.message;
      status.hidden = false;
    }
  });

  message('ready');
}

if (typeof acquireVsCodeApi === 'function') startWebview();
else if (typeof module !== 'undefined') module.exports = { layoutGraph, graphLayout, nextDiffSelection };
