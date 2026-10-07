'use strict';

function chunkPages(items = [], size = 4) {
  const source = Array.isArray(items) ? items : [];
  const chunkSize = Math.max(1, Math.min(16, Number(size) || 4));
  const groups = [];
  for (let i = 0; i < source.length; i += chunkSize) groups.push(source.slice(i, i + chunkSize));
  return groups;
}

async function runPageTaskGroups(items, {
  taskSize = 4,
  concurrency = 4,
  signal,
  onTaskStart,
  handlePage
} = {}) {
  if (typeof handlePage !== 'function') throw new Error('handlePage is required');
  const groups = chunkPages(items, taskSize);
  if (!groups.length) return { groups:0, tasks:0 };
  const taskCount = Math.min(Math.max(1, Number(concurrency) || 4), groups.length);
  let cursor = 0;

  const worker = async taskIndex => {
    const taskId = taskIndex + 1;
    while (true) {
      if (signal?.aborted) throw new Error('ยกเลิก task แล้ว');
      const groupIndex = cursor++;
      if (groupIndex >= groups.length) return;
      const group = groups[groupIndex];
      onTaskStart?.({ taskId, groupIndex, pages:group });
      for (let pageOffset = 0; pageOffset < group.length; pageOffset++) {
        if (signal?.aborted) throw new Error('ยกเลิก task แล้ว');
        await handlePage(group[pageOffset], { taskId, groupIndex, pageOffset, groupSize:group.length });
      }
    }
  };

  await Promise.all(Array.from({ length:taskCount }, (_, index) => worker(index)));
  return { groups:groups.length, tasks:taskCount };
}

module.exports = { chunkPages, runPageTaskGroups };
