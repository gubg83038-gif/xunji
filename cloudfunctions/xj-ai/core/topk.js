/** 有界候选堆：compare < 0 表示更优；同分时保留原始顺序。 */
class TopK {
  constructor(limit, compare) {
    this.limit = Math.max(0, Math.floor(Number(limit) || 0));
    this.compare = compare;
    this.heap = [];
    this.order = 0;
  }
  compareEntries(a, b) { return this.compare(a.value, b.value) || a.order - b.order; }
  push(value) {
    const entry = { value, order: this.order++ };
    if (!this.limit) return;
    const heap = this.heap;
    if (heap.length < this.limit) {
      heap.push(entry);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = Math.floor((i - 1) / 2);
        if (this.compareEntries(heap[parent], heap[i]) >= 0) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
      return;
    }
    // 堆顶是最差候选；更差的新候选立即丢弃。
    if (this.compareEntries(entry, heap[0]) >= 0) return;
    heap[0] = entry;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && this.compareEntries(heap[child + 1], heap[child]) > 0) child += 1;
      if (this.compareEntries(heap[i], heap[child]) >= 0) break;
      [heap[i], heap[child]] = [heap[child], heap[i]];
      i = child;
    }
  }
  values() { return this.heap.slice().sort((a, b) => this.compareEntries(a, b)).map((entry) => entry.value); }
}
module.exports = TopK;
