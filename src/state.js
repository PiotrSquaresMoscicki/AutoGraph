// state.js — Undo/redo stack of DOT strings. Resets on page refresh.

export class History {
  constructor(initial) {
    this.stack = [initial];
    this.index = 0;
    this.listeners = new Set();
  }
  get current() {
    return this.stack[this.index];
  }
  push(dot) {
    if (dot === this.current) return;
    // Drop any future redo states.
    this.stack.length = this.index + 1;
    this.stack.push(dot);
    this.index = this.stack.length - 1;
    this._emit();
  }
  replaceTop(dot) {
    // Replace top without pushing — used for live editor typing to coalesce.
    if (this.stack[this.index] === dot) return;
    this.stack[this.index] = dot;
    this._emit();
  }
  canUndo() {
    return this.index > 0;
  }
  canRedo() {
    return this.index < this.stack.length - 1;
  }
  undo() {
    if (!this.canUndo()) return null;
    this.index--;
    this._emit();
    return this.current;
  }
  redo() {
    if (!this.canRedo()) return null;
    this.index++;
    this._emit();
    return this.current;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    for (const fn of this.listeners) fn(this);
  }
}
