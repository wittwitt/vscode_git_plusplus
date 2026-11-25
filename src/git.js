'use strict';

const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const pageSize = 200;
const refCollator = new Intl.Collator(undefined, { numeric: true });

async function git(root, gitPath, args, input, signal, { env, timeout = 15000 } = {}) {
  const execution = exec(gitPath, args, {
    cwd: root,
    encoding: 'buffer',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    signal,
    env,
  });
  if (input !== undefined) {
    const stdin = execution.child.stdin;
    // execFile reports the process error if Git exits before reading all revisions.
    stdin.on('error', () => {});
    stdin.end(input);
  }
  try {
    const { stdout } = await execution;
    return stdout.toString('utf8');
  } catch (error) {
    if (Buffer.isBuffer(error.stderr)) error.stderr = error.stderr.toString('utf8');
    throw error;
  }
}

async function readRefs(root, gitPath, signal) {
  const format = [
    '%(refname)', '%(authorname)', '%(taggername)', '%(*authorname)',
    '%(HEAD)', '%(symref)', '%(objecttype)', '%(objectname)', '%(*objecttype)', '%(*objectname)',
    '%(upstream)', '%(upstream:track,nobracket)', '%(taggerdate:iso-strict)',
    '%(upstream:remotename)', '%(upstream:remoteref)', '%(push:remotename)', '%(push:remoteref)',
  ].join('%00');
  const output = await git(root, gitPath, [
    'for-each-ref', '--sort=refname', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags',
  ], undefined, signal, { env: { ...process.env, LC_ALL: 'C' } });
  return output.split('\n').filter(Boolean).flatMap(line => {
    const [
      fullName, author, tagger, peeledAuthor, head, symref, type, hash, peeledType, peeledHash, upstream, tracking, taggerDate,
      upstreamRemote, upstreamRemoteRef, pushRemote, pushRemoteRef,
    ] = line.split('\0');
    if (symref) return [];
    const [, namespace, name] = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(fullName);
    const tracksRemote = namespace === 'heads' && upstream.startsWith('refs/remotes/') && tracking !== 'gone';
    return [{
      fullName,
      name,
      group: namespace,
      author: tagger || peeledAuthor || author || '',
      authorSource: tagger ? 'Tag creator' : 'Commit author',
      tagger: tagger || undefined,
      taggerDate: taggerDate || undefined,
      current: head === '*',
      hash: type === 'commit' ? hash : peeledType === 'commit' ? peeledHash : undefined,
      upstream: upstream || undefined,
      ...(namespace === 'heads' && { upstreamRemote, upstreamRemoteRef, pushRemote, pushRemoteRef }),
      ...(tracksRemote && {
        ahead: Number(/\bahead (\d+)/.exec(tracking)?.[1] ?? 0),
        behind: Number(/\bbehind (\d+)/.exec(tracking)?.[1] ?? 0),
      }),
    }];
  });
}

async function readRemoteNames(root, gitPath) {
  return (await git(root, gitPath, ['remote'])).split('\n').filter(Boolean);
}

async function readRemoteConfig(root, gitPath, signal) {
  const fingerprint = await git(root, gitPath, ['remote', '-v'], undefined, signal);
  const names = [...new Set(fingerprint.split('\n').filter(Boolean).map(line => line.split('\t', 1)[0]))];
  return { fingerprint, names };
}

async function resolveRemoteBranchRef(root, gitPath, remote, trackingRef) {
  const output = await git(root, gitPath, ['config', '--get-all', `remote.${remote}.fetch`]);
  const matches = new Set();
  for (const spec of output.split('\n')) {
    const [source, destination] = spec.replace(/^\+/, '').split(':');
    if (!source.startsWith('refs/heads/') || !destination) continue;
    if (destination === trackingRef) matches.add(source);
    const wildcard = destination.indexOf('*');
    if (wildcard === -1) continue;
    const prefix = destination.slice(0, wildcard);
    const suffix = destination.slice(wildcard + 1);
    if (trackingRef.startsWith(prefix) && trackingRef.endsWith(suffix) && trackingRef.length > prefix.length + suffix.length) {
      const substitution = trackingRef.slice(prefix.length, trackingRef.length - suffix.length);
      matches.add(source.replace('*', () => substitution));
    }
  }
  if (matches.size !== 1) throw new Error('Could not determine which branch the remote-tracking ref represents.');
  return matches.values().next().value;
}

async function readRemoteTagNames(root, gitPath, remoteNames, signal) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const results = await Promise.allSettled(remoteNames.map(remote =>
    git(root, gitPath, ['ls-remote', '--tags', '--refs', '--', remote], undefined, signal, { env }),
  ));
  // A failed lookup cannot establish that the tag is absent from every remote.
  if (results.some(result => result.status === 'rejected')) return;
  return new Set(results.flatMap(({ value }) => value.split('\n').filter(Boolean).map(line => line.split('\t')[1])));
}

function buildRefTree(refs, nameOf = ref => ref.name) {
  const roots = new Map();
  for (const ref of refs) {
    let children = roots;
    const segments = nameOf(ref).split('/');
    for (const [index, label] of segments.entries()) {
      if (!children.has(label)) children.set(label, { label, children: new Map() });
      const node = children.get(label);
      if (index === segments.length - 1) node.ref = ref;
      children = node.children;
    }
  }
  function sorted(nodes) {
    return [...nodes.values()]
      .sort((a, b) => {
        if (Boolean(a.ref) !== Boolean(b.ref)) return a.ref ? -1 : 1;
        return refCollator.compare(a.label, b.label);
      })
      .map(node => ({ ...node, children: sorted(node.children) }));
  }
  return sorted(roots);
}

async function resolveCommit(root, gitPath, fullName, signal) {
  const output = await git(root, gitPath, ['rev-parse', '--verify', '--end-of-options', `${fullName}^{commit}`], undefined, signal);
  return output.trim();
}

function openHistory(root, gitPath, start, options) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options?.signal?.aborted) abort();
  else options?.signal?.addEventListener('abort', abort, { once: true });
  const records = logRecords(root, gitPath, start, ['%H', '%h', '%P', '%an', '%cI', '%s'], {
    ...options, signal: controller.signal,
  });
  const commits = [];
  let pending = Promise.resolve();
  let done = false;

  return {
    read(limit, offset = 0) {
      // A superseded search may finish reading a batch. The next request can reuse it.
      const batch = pending.then(async () => {
        while (!done && commits.length <= limit) {
          const record = await records.next();
          done = record.done;
          if (!done) {
            const [hash, shortHash, parents, author, date, subject] = record.value;
            commits.push({ hash, shortHash, parents: parents ? parents.split(' ') : [], author, date, subject });
          }
        }
        return { commits: commits.slice(offset, limit), hasMore: commits.length > limit };
      });
      pending = batch;
      return batch;
    },
    close() {
      options?.signal?.removeEventListener('abort', abort);
      abort();
      void records.return().catch(() => {});
    },
  };
}

async function readHistory(root, gitPath, limit, start, options) {
  const history = openHistory(root, gitPath, start, options);
  try {
    return await history.read(limit);
  } finally {
    history.close();
  }
}

function runCommitDiff(root, gitPath, hash, parent, format, paths, signal) {
  const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
  if (!objectId.test(hash) || (parent !== undefined && !objectId.test(parent))) {
    throw new Error('Invalid Git commit ID.');
  }
  const options = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', ...format];
  const args = parent
    ? ['diff', ...options, parent, hash]
    : ['show', '--root', '--format=', ...options, hash];
  return git(root, gitPath, ['--literal-pathspecs', ...args, '--', ...paths], undefined, signal);
}

function changedFiles(output) {
  const fields = output.split('\0');
  const files = [];
  for (let index = 0; fields[index];) {
    // Accept both name-status and raw diff records.
    const status = fields[index++].split(' ').at(-1)[0];
    const firstPath = fields[index++];
    if (status === 'R' || status === 'C') {
      files.push({ status, path: fields[index++], oldPath: firstPath });
    } else {
      files.push({ status, path: firstPath });
    }
  }
  return files;
}

function readCommitDiff(root, gitPath, hash, parent, signal) {
  return runCommitDiff(root, gitPath, hash, parent, ['--patch'], [], signal);
}

async function readCommitFiles(root, gitPath, hash, parent, signal) {
  const output = await runCommitDiff(root, gitPath, hash, parent, ['--name-status', '-z'], [], signal);
  return changedFiles(output);
}

async function readCommitFileDiff(root, gitPath, hash, parent, file, signal) {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const output = await runCommitDiff(root, gitPath, hash, parent, [
    '--raw', '-z', '--patch', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
  ], paths, signal);
  const separator = output.indexOf('\0\0');
  if (separator < 0) return '';
  // Match the exact file even when Git's path filter also includes descendants.
  const files = changedFiles(output.slice(0, separator));
  const index = files.findIndex(entry => entry.path === file.path && entry.oldPath === file.oldPath);
  const patches = output.slice(separator + 2).split(/(?=^diff --git )/m);
  return patches[index] ?? '';
}

function readCommitFileVersion(root, gitPath, revision, path, signal) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision) || !path) throw new Error('Invalid Git file revision.');
  return git(root, gitPath, ['cat-file', 'blob', `${revision}:${path}`], undefined, signal);
}

async function readCommitFileComparison(root, gitPath, hash, parent, file, signal) {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const stat = await runCommitDiff(root, gitPath, hash, parent, ['--numstat', '-z'], paths, signal);
  const fields = stat.split('\0');
  let binary = false;
  for (let index = 0; fields[index];) {
    const record = fields[index++];
    const delimiter = record.indexOf('\t', record.indexOf('\t') + 1);
    const path = record.slice(delimiter + 1);
    const oldPath = path ? undefined : fields[index++];
    const newPath = path || fields[index++];
    if (newPath === file.path && oldPath === file.oldPath) {
      binary = record.startsWith('-\t-\t');
      break;
    }
  }
  try {
    if (!binary) {
      const [before, after] = await Promise.all([
        parent && file.status !== 'A' ? readCommitFileVersion(root, gitPath, parent, file.oldPath ?? file.path, signal) : '',
        file.status !== 'D' ? readCommitFileVersion(root, gitPath, hash, file.path, signal) : '',
      ]);
      if (!before.includes('\0') && !after.includes('\0')) return { before, after };
    }
  } catch (error) {
    // Gitlinks and blobs too large for the text reader still have a Git patch.
    if (error.code !== 128 && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
  }
  return { patch: await readCommitFileDiff(root, gitPath, hash, parent, file, signal) };
}

async function* logRecords(root, gitPath, start, format, { signal, firstParent, mergesOnly }) {
  const fromTips = Array.isArray(start);
  if (fromTips && !start.length) return;
  const child = spawn(gitPath, [
    'log', '-z', '--topo-order', '--encoding=UTF-8', '--abbrev=8',
    ...(firstParent ? ['--first-parent'] : []),
    ...(mergesOnly ? ['--merges'] : []), `--format=${format.join('%x00')}`, fromTips ? '--stdin' : start ?? '--all', '--',
  ], { cwd: root, windowsHide: true, signal });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', code => resolve({ code }));
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    if (stderr.length < 2048) stderr += chunk.toString('utf8');
  });
  child.stdin.on('error', () => {});
  child.stdin.end(fromTips ? `${start.join('\n')}\n` : undefined);

  let fragments = [];
  let fields = [];
  try {
    for await (const chunk of child.stdout) {
      let offset = 0;
      for (let end = chunk.indexOf(0); end >= 0; end = chunk.indexOf(0, offset)) {
        const bytes = chunk.subarray(offset, end);
        fields.push((fragments.length ? Buffer.concat([...fragments, bytes]) : bytes).toString('utf8'));
        fragments = [];
        if (fields.length === format.length) {
          yield fields;
          fields = [];
        }
        offset = end + 1;
      }
      if (offset < chunk.length) fragments.push(chunk.subarray(offset));
    }
    const { error, code } = await completion;
    if (error) throw error;
    if (code !== 0) throw new Error(stderr.trim() || `git log exited with status ${code}`);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}

async function findHistoryMatch(root, gitPath, tips, query, { after, ...options } = {}) {
  const needle = query.toLowerCase();
  let position = 0;
  let pastAnchor = !after;
  let firstMatch;
  for await (const [hash, message] of logRecords(root, gitPath, tips, ['%H', '%B'], options)) {
    position++;
    if (hash.includes(needle) || message.toLowerCase().includes(needle)) {
      const match = { hash, position };
      if (pastAnchor) return match;
      firstMatch ??= match;
    }
    if (hash === after) pastAnchor = true;
  }
  return firstMatch;
}

async function readBranchTipsContaining(root, gitPath, hash, signal) {
  const output = await git(root, gitPath, [
    'for-each-ref', `--contains=${hash}`, '--format=%(objectname)', 'refs/heads', 'refs/remotes',
  ], undefined, signal);
  return new Set(output.trim().split('\n'));
}

async function applyCommitAction(root, gitPath, commit, action, options) {
  const { hash, parents } = commit;
  const name = typeof options.name === 'string' ? options.name.trim() : '';
  let args;
  switch (action) {
    case 'branch':
    case 'checkout': {
      if (action === 'branch' && !name) throw new Error('Enter a branch name.');
      if (name) {
        const checked = await git(root, gitPath, ['check-ref-format', '--branch', name]);
        if (checked.trim() !== name) throw new Error('Enter a valid branch name.');
      }
      if (action === 'branch' && options.checkout !== true) {
        args = ['branch', '--', name, hash];
      } else {
        args = ['switch', '--no-guess', '--no-overwrite-ignore'];
        if (action === 'checkout') {
          if (options.merge === true) args.push('--merge');
          args.push(options.submodules === true ? '--recurse-submodules' : '--no-recurse-submodules');
        }
        args.push(...(name ? ['--create', name] : ['--detach']), '--', hash);
      }
      break;
    }
    case 'tag': {
      if (!name) throw new Error('Enter a tag name.');
      const { tagType, tagMessage } = options;
      if (tagType === 'lightweight') {
        args = ['tag', '--no-sign'];
      } else if (tagType === 'annotated' || tagType === 'signed') {
        if (typeof tagMessage !== 'string' || !tagMessage.trim()) throw new Error('Enter a tag message.');
        const message = tagMessage.endsWith('\n') ? tagMessage : `${tagMessage}\n`;
        args = ['tag', tagType === 'signed' ? '--sign' : '--no-sign', '--annotate',
          '--cleanup=verbatim', '--message', message];
      } else {
        throw new Error('Select a tag type.');
      }
      args.push('--', name, hash);
      break;
    }
    case 'revert':
    case 'cherryPick': {
      args = action === 'revert' ? ['revert', '--no-edit'] : ['cherry-pick'];
      if (parents.length > 1) {
        const { mainline } = options;
        if (!Number.isInteger(mainline) || mainline < 1 || mainline > parents.length) {
          throw new Error('Select a mainline parent.');
        }
        args.push('--mainline', String(mainline));
      }
      args.push('--', hash);
      break;
    }
    default:
      throw new Error('Unknown commit action.');
  }
  await git(root, gitPath, args);
}

module.exports = {
  git, buildRefTree, pageSize, readRefs, openHistory, readHistory, readCommitDiff, readCommitFiles, readCommitFileDiff,
  readCommitFileComparison, readCommitFileVersion, findHistoryMatch,
  resolveCommit, readBranchTipsContaining, readRemoteNames, readRemoteConfig, resolveRemoteBranchRef, readRemoteTagNames, applyCommitAction,
};
