'use strict';

const palette = [
  '#3b82d6', '#dc7431', '#25a06b', '#925cd0',
  '#d44e68', '#a88a24', '#1399ab', '#bf589f',
  '#79933b', '#686fce', '#ad6743', '#248f81',
];

function colorAt(index) {
  if (index < palette.length) return palette[index];
  const hue = Math.round(index * 137.508) % 360;
  const lightness = 42 + (index % 3) * 6;
  return `hsl(${hue}, 67%, ${lightness}%)`;
}

class BranchColors {
  constructor(storage, output) {
    this.storage = storage;
    this.output = output;
    this.repositories = new Map();
  }

  decorate(root, refs) {
    const key = `gitPlusPlus.branchColors:${root}`;
    let colors = this.repositories.get(root);
    if (!colors) {
      colors = new Map(this.storage.get(key) ?? []);
      this.repositories.set(root, colors);
    }
    const originalSize = colors.size;
    const decorated = refs.map(ref => {
      if (ref.group === 'tags') return ref;
      if (!colors.has(ref.fullName)) colors.set(ref.fullName, colorAt(colors.size));
      return { ...ref, color: colors.get(ref.fullName) };
    });
    if (colors.size !== originalSize) {
      void this.storage.update(key, [...colors]).then(undefined, error => {
        this.output.appendLine(`${root}: Could not save branch colors: ${error.message}`);
      });
    }
    return decorated;
  }
}

module.exports = { BranchColors };
