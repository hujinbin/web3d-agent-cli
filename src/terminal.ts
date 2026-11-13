import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';

export function createTerminal() {
  let muted = false;
  let history: string[] = [];
  const closed = new AbortController();
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (muted) callback();
      else stdout.write(chunk, encoding, callback);
    },
  });
  Object.defineProperties(output, {
    isTTY: { get: () => stdout.isTTY },
    columns: { get: () => stdout.columns ?? 80 },
  });
  const readline = createInterface({ input: stdin, output, terminal: true });
  readline.on('close', () => closed.abort());
  readline.on('history', entries => {
    // 密钥输入既不回显，也不进入随后可用方向键召回的历史。
    if (muted) entries.splice(0, entries.length, ...history);
    else history = [...entries];
  });
  const question = (prompt: string, options: { signal?: AbortSignal } = {}) => readline.question(prompt, {
    signal: options.signal ? AbortSignal.any([closed.signal, options.signal]) : closed.signal,
  });
  return {
    readline,
    question,
    write: (text: string) => { stdout.write(text); },
    async secret(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string> {
      stdout.write(prompt);
      muted = true;
      try { return await question('', options); }
      finally { muted = false; stdout.write('\n'); }
    },
    close: () => readline.close(),
  };
}
