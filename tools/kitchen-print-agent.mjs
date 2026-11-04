#!/usr/bin/env node
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import iconv from 'iconv-lite';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bool = (v, fallback = false) => v == null ? fallback : /^(1|true|yes|on)$/i.test(String(v));
const int = (v, fallback) => {
  const n = Number.parseInt(String(v || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function readConfig() {
  let baseUrl = process.env.HL_PRINT_BASE_URL || process.env.HL_BASE_URL || '';
  let token = process.env.HL_PRINT_TOKEN || '';
  const kitchenUrl = process.env.HL_KITCHEN_URL || '';
  if (kitchenUrl) {
    const u = new URL(kitchenUrl);
    baseUrl ||= u.origin;
    token ||= u.searchParams.get('t') || '';
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token,
    session: process.env.HL_KITCHEN_SESSION || '',
    password: process.env.HL_KITCHEN_PASSWORD || process.env.HL_PRINT_PASSWORD || '',
    printer: process.env.HL_PRINT_PRINTER || '',
    device: process.env.HL_PRINT_DEVICE || '',
    baudRate: int(process.env.HL_PRINT_BAUD, 0),
    mode: (process.env.HL_PRINT_MODE || 'text').toLowerCase(),
    intervalMs: int(process.env.HL_PRINT_INTERVAL_MS, 5000),
    waitMs: int(process.env.HL_PRINT_WAIT_MS, 90000),
    dryRun: bool(process.env.HL_PRINT_DRY_RUN),
    keepFiles: bool(process.env.HL_PRINT_KEEP_FILES),
    once: bool(process.env.HL_PRINT_ONCE),
    ackOnSubmit: bool(process.env.HL_PRINT_ACK_ON_SUBMIT, process.platform === 'win32'),
    lpOptions: (process.env.HL_PRINT_LP_OPTIONS || 'sides=one-sided Duplex=None job-sheets=none')
      .split(/\s+/).map((s) => s.trim()).filter(Boolean),
    tspl: {
      widthMm: int(process.env.HL_TSPL_WIDTH_MM, 76),
      minHeightMm: int(process.env.HL_TSPL_HEIGHT_MM, 120),
      gapMm: Number.isFinite(Number(process.env.HL_TSPL_GAP_MM)) ? Number(process.env.HL_TSPL_GAP_MM) : 0,
      density: int(process.env.HL_TSPL_DENSITY, 8),
      speed: int(process.env.HL_TSPL_SPEED, 4),
      leftDots: int(process.env.HL_TSPL_LEFT_DOTS, 16),
      topDots: int(process.env.HL_TSPL_TOP_DOTS, 16),
      lineDots: int(process.env.HL_TSPL_LINE_DOTS, 32),
      cols: int(process.env.HL_TSPL_COLS, 32),
      font: process.env.HL_TSPL_FONT || 'TSS24.BF2',
      xMul: int(process.env.HL_TSPL_XMUL, 1),
      yMul: int(process.env.HL_TSPL_YMUL, 1),
      encoding: process.env.HL_TSPL_ENCODING || 'utf8',
      codepage: process.env.HL_TSPL_CODEPAGE || 'UTF-8',
    },
  };
}

function endpoint(config, pathname) {
  const u = new URL(pathname, config.baseUrl);
  if (config.token) u.searchParams.set('t', config.token);
  return u;
}

function authHeaders(config, extra = {}) {
  return config.session ? { authorization: `Bearer ${config.session}`, ...extra } : extra;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function parseCupsJobId(output) {
  const m = String(output || '').match(/([A-Za-z0-9_.-]+-\d+)/);
  return m ? m[1] : '';
}

function cellWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (cp <= 0x115F || cp === 0x2329 || cp === 0x232A || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE10 && cp <= 0xFE19) || (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6))) ? 2 : 1;
  }
  return w;
}

function cutCells(s, max) {
  let out = '';
  let w = 0;
  for (const ch of String(s || '')) {
    const cw = cellWidth(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out;
}

function wrapCells(s, width) {
  const clean = String(s || '').replace(/\t/g, '  ');
  if (!clean) return [''];
  const lines = [];
  let rest = clean;
  while (rest) {
    const take = cutCells(rest, width);
    lines.push(take);
    rest = rest.slice(take.length);
  }
  return lines.length ? lines : [''];
}

function escapeTsplText(s) {
  return String(s || '').replace(/"/g, "'");
}

function encodeText(s, encoding) {
  return encoding.toLowerCase() === 'utf8' || encoding.toLowerCase() === 'utf-8'
    ? Buffer.from(s, 'utf8')
    : iconv.encode(s, encoding);
}

function buildTspl(content, config) {
  const t = config.tspl;
  const lines = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .flatMap((line) => wrapCells(line, t.cols));
  const dotsPerMm = 8; // GP-3120TN is 203 DPI.
  const neededMm = Math.ceil((t.topDots + lines.length * t.lineDots + 32) / dotsPerMm);
  const heightMm = Math.max(t.minHeightMm, neededMm);
  const commands = [
    `SIZE ${t.widthMm} mm,${heightMm} mm`,
    `GAP ${t.gapMm} mm,0 mm`,
    'DIRECTION 1',
    'REFERENCE 0,0',
    `SPEED ${t.speed}`,
    `DENSITY ${t.density}`,
    'CLS',
    `CODEPAGE ${t.codepage}`,
  ];
  lines.forEach((line, idx) => {
    const y = t.topDots + idx * t.lineDots;
    commands.push(`TEXT ${t.leftDots},${y},"${t.font}",0,${t.xMul},${t.yMul},"${escapeTsplText(line)}"`);
  });
  commands.push('PRINT 1,1', '');
  return encodeText(commands.join('\r\n'), t.encoding);
}

async function waitForCupsCompletion(config, cupsJobId) {
  if (!cupsJobId || !config.printer) return true;
  const started = Date.now();
  while (Date.now() - started < config.waitMs) {
    const { stdout } = await run('lpstat', ['-W', 'not-completed', '-o', config.printer]).catch(() => ({ stdout: '' }));
    if (!stdout.includes(cupsJobId)) return true;
    await sleep(3000);
  }
  return false;
}

async function printWithLp(config, file, title) {
  const args = [];
  if (config.printer) args.push('-d', config.printer);
  args.push('-t', title);
  for (const option of config.lpOptions) args.push('-o', option);
  args.push(file);
  const result = await run('lp', args);
  return parseCupsJobId(result.stdout + result.stderr);
}

async function printWithLpRaw(config, file, title) {
  const args = [];
  if (config.printer) args.push('-d', config.printer);
  args.push('-t', title, '-o', 'raw', file);
  const result = await run('lp', args);
  return parseCupsJobId(result.stdout + result.stderr);
}

async function printWithDevice(config, file) {
  if (config.baudRate) {
    const sttyArgs = process.platform === 'darwin'
      ? ['-f', config.device, String(config.baudRate), 'cs8', '-cstopb', '-parenb']
      : ['-F', config.device, String(config.baudRate), 'cs8', '-cstopb', '-parenb'];
    await run('stty', sttyArgs).catch(() => {});
  }
  await run('sh', ['-c', 'cat "$1" > "$2"', 'sh', file, config.device]);
}

async function printWithPowerShellText(config, file) {
  const script = config.printer
    ? '$p=$args[0];$n=$args[1];Get-Content -Raw -LiteralPath $p | Out-Printer -Name $n'
    : '$p=$args[0];Get-Content -Raw -LiteralPath $p | Out-Printer';
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script, file];
  if (config.printer) args.push(config.printer);
  await run('powershell.exe', args);
}

async function printWithPowerShellRaw(config, file) {
  const script = String.raw`
param([string]$Path,[string]$PrinterName)
if (-not $PrinterName) {
  $PrinterName = (Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1 -ExpandProperty Name)
}
if (-not $PrinterName) { throw "No printer selected and no default printer found" }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, Int32 dwCount, out Int32 dwWritten);
  public static void Send(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) throw new Exception("OpenPrinter failed");
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "Hawkerline Kitchen";
      di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, di)) throw new Exception("StartDocPrinter failed");
      try {
        if (!StartPagePrinter(hPrinter)) throw new Exception("StartPagePrinter failed");
        try {
          int written;
          if (!WritePrinter(hPrinter, bytes, bytes.Length, out written) || written != bytes.Length) throw new Exception("WritePrinter failed");
        } finally { EndPagePrinter(hPrinter); }
      } finally { EndDocPrinter(hPrinter); }
    } finally { ClosePrinter(hPrinter); }
  }
}
"@
[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($Path))
`;
  const ps1 = path.join(path.dirname(file), 'raw-print.ps1');
  await writeFile(ps1, script, 'utf8');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Path', file];
  if (config.printer) args.push('-PrinterName', config.printer);
  await run('powershell.exe', args);
}

async function submitPrint(config, file, title, raw = false) {
  if (config.dryRun) {
    console.log(`[dry-run] ${title} -> ${file}`);
    return '';
  }
  if (config.device) {
    await printWithDevice(config, file);
    return '';
  }
  if (process.platform === 'win32') {
    if (raw) await printWithPowerShellRaw(config, file);
    else await printWithPowerShellText(config, file);
    return '';
  }
  if (raw) return printWithLpRaw(config, file, title);
  return printWithLp(config, file, title);
}

async function ack(config, ids) {
  const r = await authorizedFetch(config, '/api/print/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!r.ok) throw new Error(`ack failed ${r.status}`);
  return r.json();
}

async function fetchPending(config) {
  const r = await authorizedFetch(config, '/api/print/pending');
  if (!r.ok) throw new Error(`pending failed ${r.status}`);
  const d = await r.json();
  return Array.isArray(d.jobs) ? d.jobs : [];
}

async function loginKitchen(config) {
  if (config.token || config.session || !config.password) return;
  const r = await fetch(new URL('/api/kitchen/login', config.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: config.password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw new Error(d.error || `kitchen login failed ${r.status}`);
  config.session = d.token;
}

async function authorizedFetch(config, pathname, options = {}, retry = true) {
  await loginKitchen(config);
  const headers = authHeaders(config, options.headers || {});
  const r = await fetch(endpoint(config, pathname), { ...options, headers });
  if (r.status === 401 && config.password && retry) {
    config.session = '';
    await loginKitchen(config);
    return authorizedFetch(config, pathname, options, false);
  }
  return r;
}

async function processJob(config, job, blocked) {
  if (blocked.has(job.id)) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'hl-print-'));
  const raw = config.mode === 'tspl';
  const file = path.join(dir, `${job.id}.${raw ? 'tspl' : 'txt'}`);
  const title = `HL ${job.order_id || job.id}`.slice(0, 80);
  await writeFile(file, raw ? buildTspl(job.content || '', config) : `${job.content || ''}\n\n\n`, raw ? undefined : 'utf8');
  try {
    console.log(`[print] ${job.order_id || job.id}`);
    const cupsJobId = await submitPrint(config, file, title, raw);
    if (config.dryRun) return;
    if (!config.ackOnSubmit && process.platform !== 'win32') {
      const done = await waitForCupsCompletion(config, cupsJobId);
      if (!done) {
        blocked.add(job.id);
        console.error(`[blocked] printer queue did not complete within ${config.waitMs}ms; not acking ${job.order_id || job.id}`);
        return;
      }
    }
    await ack(config, [job.id]);
    console.log(`[acked] ${job.order_id || job.id}`);
  } finally {
    if (!config.keepFiles) unlink(file).catch(() => {});
  }
}

async function main() {
  const config = readConfig();
  if (!config.baseUrl || (!config.token && !config.session && !config.password)) {
    console.error([
      'Missing print endpoint.',
      'Set HL_KITCHEN_URL="https://your-store.example/kitchen?t=kp_xxx"',
      'or set HL_PRINT_BASE_URL and HL_PRINT_TOKEN.',
      'or set HL_PRINT_BASE_URL and HL_KITCHEN_PASSWORD.',
    ].join('\n'));
    process.exit(2);
  }

  await loginKitchen(config);

  console.log(`[start] ${config.baseUrl} interval=${config.intervalMs}ms printer=${config.printer || '(default)'}`);
  console.log(`[print] mode=${config.mode}${config.device ? ` device=${config.device}` : ''}`);
  if (config.dryRun) console.log('[mode] dry-run: no print or ack');

  const blocked = new Set();
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  while (!stopping) {
    try {
      const jobs = await fetchPending(config);
      for (const job of jobs) {
        await processJob(config, job, blocked);
      }
    } catch (e) {
      console.error(`[error] ${e.message}`);
    }
    if (config.once) break;
    await sleep(config.intervalMs);
  }
  console.log('[stop] kitchen print agent stopped');
}

main().catch((e) => {
  console.error(`[fatal] ${e.stack || e.message}`);
  process.exit(1);
});
