import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// 独立 Node 进程里拦住 Playwright 启动，验证真实 runner 的参数、筛选与退出码。
// 不启动 Electron；真实 Playwright 的收集路径另用 --list 定点验收。
const harness = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
const titles = ['后台标记 @daily', '桌面标记 @headed @daily', '额外标记'];
childProcess.spawn = (_exe, args, options) => {
  console.log(JSON.stringify({ args, lane: options.env.TSUBASATERMINAL_E2E_HIDDEN }));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  const grep = new RegExp(args[args.lastIndexOf('--grep') + 1]);
  const specs = titles.filter(title => grep.test(title)).map(() => ({ tests: [{}] }));
  queueMicrotask(() => {
    if (options.stdio[1] === 'pipe')
      child.stdout.emit('data', JSON.stringify({ suites: [{ specs, suites: [] }] }));
    child.emit('close', 0, null);
  });
  return child;
};
syncBuiltinESMExports();
process.argv = ['node', 'scripts/run-e2e.mjs', ...JSON.parse(process.env.RUNNER_TEST_ARGS)];
await import('./scripts/run-e2e.mjs');
`

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEST_ARGS: JSON.stringify(args) },
    windowsHide: true
  })
  if (result.error) throw result.error
  const calls = result.stdout.split('\n').filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as { args: string[]; lane: string })
  return { ...result, calls, runs: calls.filter(call => !call.args.includes('--reporter=json')) }
}

describe('e2e runner CLI contract', () => {
  it('forwards file, list, repeat, inverse filter and worker options to both lanes', () => {
    const args = ['e2e/cli.spec.ts', '--list', '--repeat-each=3', '-G', '排除', '--workers=1']
    const result = run('daily', ...args)
    expect(result.status).toBe(0)
    expect(result.runs.map(call => call.lane)).toEqual(['1', '0'])
    for (const call of result.runs) {
      expect(call.args.slice(3, 3 + args.length)).toEqual(args)
      const pattern = new RegExp(call.args.at(-1)!)
      expect(pattern.test('额外标记')).toBe(false)
      expect(pattern.test('后台标记 @daily')).toBe(call.lane === '1')
      expect(pattern.test('桌面标记 @headed @daily')).toBe(call.lane === '0')
    }
  })

  it.each([['--grep', '^桌面'], ['--grep=^桌面'], ['-g', '^桌面'], ['-g^桌面']])(
    'intersects %j with the lane and skips the empty lane', (...grepArgs) => {
      const result = run('daily', ...grepArgs, '--list')
      expect(result.status).toBe(0)
      expect(result.runs.map(call => call.lane)).toEqual(['0'])
      expect(result.calls).toHaveLength(3)
    }
  )

  it('fails an entirely empty selection unless explicitly allowed', () => {
    const empty = run('full', '--grep', '不存在')
    expect(empty.status).toBe(1)
    expect(empty.runs).toHaveLength(0)
    expect(empty.stderr).toContain('没有匹配的测试')
    expect(run('full', '--grep', '不存在', '--pass-with-no-tests').status).toBe(0)
  })
})
