import type { ToolContext } from '../types.js';
import { checkAbort, fingerprint, integerArg, MAX_FILE_BYTES, MAX_OUTPUT_CHARS, readText, textArg, workspacePath } from './workspace.js';

type Interval = [number, number];
interface Coverage { hash: string; intervals: Interval[]; total: number }
interface ReadResult {
  path: string;
  content: string;
  totalLines: number;
  offset: number;
  returnedLines: number;
  nextOffset: number | null;
  partial: boolean;
  truncated: boolean;
  fullyRead: boolean;
}

// 覆盖证据跟随会话缓存的生命周期，不能跨文件版本或跨会话复用。
const coverageBySession = new WeakMap<Map<string, string>, Map<string, Coverage>>();

function mergeIntervals(intervals: Interval[], next: Interval): Interval[] {
  const merged: Interval[] = [];
  for (const interval of [...intervals, next].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export async function readFile(input: Record<string, unknown>, context: ToolContext): Promise<ReadResult> {
  const name = textArg(input, 'path');
  const target = await workspacePath(context, name);
  const content = await readText(target);
  checkAbort(context);
  const offset = integerArg(input, 'offset', 1, 1, MAX_FILE_BYTES + 1);
  const limit = integerArg(input, 'limit', 2000, 1, 2000);
  const lines = content.split('\n');
  const hash = fingerprint(content);
  let records = coverageBySession.get(context.readState);
  if (!records) { records = new Map(); coverageBySession.set(context.readState, records); }
  let coverage = records.get(target);
  if (!coverage || coverage.hash !== hash) {
    coverage = { hash, intervals: [], total: lines.length };
    records.set(target, coverage);
    context.readState.delete(target);
  }
  const start = Math.min(offset - 1, lines.length);
  const paged = input.offset !== undefined || input.limit !== undefined;
  const requestedEnd = paged ? Math.min(start + limit, lines.length) : lines.length;
  const makeResult = (end: number): ReadResult => ({
    path: name,
    content: lines.slice(start, end).join('\n'),
    totalLines: lines.length,
    offset,
    returnedLines: end - start,
    nextOffset: end < lines.length ? end + 1 : null,
    partial: start > 0 || end < lines.length,
    truncated: end < requestedEnd,
    fullyRead: false,
  });
  const fits = (result: ReadResult): boolean => JSON.stringify(result).length <= MAX_OUTPUT_CHARS;
  let end = requestedEnd;
  let result = makeResult(end);
  if (!fits(result)) {
    let low = start;
    let high = requestedEnd;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(makeResult(middle))) low = middle;
      else high = middle - 1;
    }
    end = low;
    result = makeResult(end);
  }
  // 只能记录实际返回的完整行；尤其不能把 JSON 转义后被二次截断的文本算作已读。
  if (!fits(result) || (end === start && start < requestedEnd)) {
    throw new Error('单行文本或路径超过工具结果上限，无法完整返回；请先在编辑器中拆分超长行，当前读取不授权覆盖。');
  }
  checkAbort(context);
  if (end > start) coverage.intervals = mergeIntervals(coverage.intervals, [start, end]);
  result.fullyRead = coverage.intervals.length === 1 && coverage.intervals[0]![0] === 0 && coverage.intervals[0]![1] === coverage.total;
  if (result.fullyRead) context.readState.set(target, hash);
  return result;
}
