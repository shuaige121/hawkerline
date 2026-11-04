// 找 Chrome，找不到就【报错退出】，绝不静默跳过。
//
// 原来四个浏览器测试各写一份 macOS 路径，找不到就 process.exit(0) ——
// 在本机看着像「这台机器没装浏览器，跳过」，放进 CI 就是【零断言绿灯】：
// 一个从没点过任何按钮的 job 报成功，比没有这个 job 还危险。
//
// 顺序：显式指定 > macOS > Linux(CI) > PATH 里找。

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];

function fromPath() {
  for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium']) {
    try {
      const p = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p && existsSync(p)) return p;
    } catch (e) { /* not on PATH */ }
  }
  return '';
}

export function findChrome() {
  const hit = CANDIDATES.filter(Boolean).find(p => existsSync(p)) || fromPath();
  if (hit) return hit;
  console.error([
    '❌ 找不到 Chrome —— 这个测试【不会】跳过，因为跳过等于零断言的假绿。',
    '   本机：装 Google Chrome，或 CHROME_PATH=/path/to/chrome node tests/xxx.mjs',
    '   CI  ：runner 需要 google-chrome-stable（ubuntu-latest 自带）',
  ].join('\n'));
  process.exit(1);
}

export default findChrome;
