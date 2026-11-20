'use strict';

class BranchFilter {
  constructor(storage, output) {
    this.storage = storage;
    this.output = output;
    this.overrides = new Map();
  }

  selected(root, refs) {
    const stored = this.overrides.get(root) ?? this.storage.get(`gitPlusPlus.branches:${root}`);
    const names = Array.isArray(stored) ? new Set(stored) : undefined;
    return refs.filter(ref => ref.group !== 'tags' &&
      (names ? names.has(ref.fullName) : ref.group === 'heads' && ref.current));
  }

  change(root, refs, fullName, checked) {
    return this.changeMatching(root, refs, ref => ref.fullName === fullName, checked);
  }

  changeGroup(root, refs, group, checked) {
    if (group === 'heads') return this.changeMatching(root, refs, ref => ref.group === 'heads', checked);
    if (typeof group !== 'string' || !group.startsWith('remotes/')) return false;
    const remote = group.slice('remotes/'.length);
    return this.changeMatching(root, refs, ref => ref.group === 'remotes' && ref.remote === remote, checked);
  }

  changeMatching(root, refs, matches, checked) {
    if (typeof checked !== 'boolean') return false;
    const names = new Set(this.selected(root, refs).map(ref => ref.fullName));
    let changed = false;
    for (const ref of refs) {
      if (ref.group === 'tags' || !matches(ref) || names.has(ref.fullName) === checked) continue;
      if (checked) names.add(ref.fullName);
      else names.delete(ref.fullName);
      changed = true;
    }
    if (!changed) return false;
    const selection = [...names];
    this.overrides.set(root, selection);
    void this.storage.update(`gitPlusPlus.branches:${root}`, selection).then(undefined, error => {
      this.output.appendLine(`${root}: Could not save the branch filter: ${error.message}`);
    });
    return true;
  }
}

module.exports = { BranchFilter };
