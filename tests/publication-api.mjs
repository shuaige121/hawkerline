// 内容管理 API 的真 HTTP 验收：鉴权、乐观并发（base_revision）、发布工作流、预览头。
//
//     node tests/publication-api.mjs

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8805;
const BASE = `https://127.0.0.1:${PORT}`;
const ADMIN = 'pub-api-admin-token';
const AUTH_SECRET = 'pub-api-auth-secret';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const persist = mkdtempSync(path.join(tmpdir(), 'hl-pub-api-'));
let child = null;
let pass = 0; const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name, extra ? `:: ${extra}` : ''); }
  else { fails.push(name); console.log('  ❌', name, extra ? `:: ${extra}` : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d1 = sql => execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local',
  '--persist-to', persist, '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rows = sql => JSON.parse(d1(sql))[0].results;

const api = async (p, { method = 'GET', admin = true, body } = {}) => {
  // D1 subprocess checks can outlast the local proxy's keep-alive timeout.
  // Open a fresh connection instead of retrying a possibly committed mutation.
  const headers = { 'content-type': 'application/json', connection: 'close' };
  if (admin) headers.authorization = 'Bearer ' + ADMIN;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let parsed = null;
  try { parsed = await r.json(); } catch (e) {}
  return { status: r.status, body: parsed, headers: r.headers };
};

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/robots.txt`); if (r.status) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}

async function main() {
  execFileSync('npx', ['wrangler@4', 'd1', 'migrations', 'apply', 'hawkerline', '--local', '--persist-to', persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'hawkerline', '--local', '--persist-to', persist, '--file', 'seed/demo.sql'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child = spawn('npx', ['wrangler@4', 'dev', '--local', '--persist-to', persist, '--port', String(PORT),
    '--local-protocol', 'https', '--test-scheduled',
    '--var', `ADMIN_TOKEN:${ADMIN}`, '--var', `AUTH_SECRET:${AUTH_SECRET}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(persist, 'wrangler.log'), { flags: 'a' });
  log.on('error', () => {});
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  if (!await waitUp()) throw new Error(`wrangler dev 没起来，日志见 ${path.join(persist, 'wrangler.log')}`);
  // Exact publication reviews an existing active snapshot. Bootstrap explicitly
  // instead of depending on whether the dev Cron happened to tick during setup.
  const bootstrap = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  if (!bootstrap.ok || !(await api('/api/admin/publication/status')).body?.active_release_id) throw new Error('本地发布 bootstrap 未完成');

  // ── 鉴权 ──────────────────────────────────────────────────────────────────
  ok('未授权创建标签被拒', (await api('/api/admin/tags', { method: 'POST', admin: false, body: { id: 'x', label_cn: 'x' } })).status === 401);
  ok('未授权读发布状态被拒', (await api('/api/admin/publication/status', { admin: false })).status === 401);

  // ── 乐观并发 ──────────────────────────────────────────────────────────────
  const start = await api('/api/admin/publication/status');
  ok('发布状态可读且带草稿版本', start.status === 200 && !!start.body.draft_revision, start.body?.draft_revision);
  const baseRevision = start.body.draft_revision;

  const created = await api('/api/admin/tags', { method: 'POST', body: {
    base_revision: baseRevision, id: 'chef-pick', label_cn: '店长推荐', label_en: "Chef's pick", tone: 'gold', icon: '⭐' } });
  ok('用正确的 base_revision 建标签成功', created.status === 200, JSON.stringify(created.body));
  ok('返回了新的草稿版本', !!created.body?.draft_revision && created.body.draft_revision !== baseRevision);

  const stale = await api('/api/admin/tags', { method: 'POST', body: {
    base_revision: baseRevision, id: 'late', label_cn: '旧页面', tone: 'red' } });
  ok('拿旧版本再写 → 409', stale.status === 409 && stale.body?.code === 'revision_conflict', String(stale.status));
  ok('冲突的写入没有落库', rows("SELECT COUNT(*) AS n FROM product_tags WHERE id='late'")[0].n === 0);

  const badTone = await api('/api/admin/tags', { method: 'POST', body: {
    base_revision: created.body.draft_revision, id: 'bad', label_cn: '坏色', tone: 'script' } });
  ok('非法 tone 被拒（400，先于任何写入）', badTone.status === 400, String(badTone.status));

  const assigned = await api('/api/admin/products/S01/tags', { method: 'PUT', body: {
    base_revision: created.body.draft_revision, tag_ids: ['chef-pick', 'fresh-meat'] } });
  ok('给商品挂标签成功', assigned.status === 200, JSON.stringify(assigned.body));
  ok('标签顺序按提交顺序落库',
    rows("SELECT tag_id FROM product_tag_assignments WHERE sku='S01' ORDER BY sort").map(r => r.tag_id).join(',') === 'chef-pick,fresh-meat');

  const inUse = await api(`/api/admin/tags/chef-pick?base_revision=${assigned.body.draft_revision}`, { method: 'DELETE' });
  ok('在用标签不允许删除', inUse.status === 409 && inUse.body?.code === 'tag_in_use', String(inUse.status));

  // ── 预览 ──────────────────────────────────────────────────────────────────
  const activeBefore = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  const preview = await api('/api/admin/publication/preview', { method: 'POST', body: { base_revision: assigned.body.draft_revision } });
  ok('预览签发成功', preview.status === 200 && /^\/preview\//.test(preview.body?.preview_url || ''), preview.body?.preview_url?.slice(0, 24));
  const previewPage = await fetch(BASE + preview.body.preview_url);
  ok('预览页 private + noindex', previewPage.headers.get('cache-control') === 'private, no-store'
    && /noindex/.test(previewPage.headers.get('x-robots-tag') || ''), previewPage.headers.get('x-robots-tag') || '');
  ok('预览页 no-referrer', previewPage.headers.get('referrer-policy') === 'no-referrer', previewPage.headers.get('referrer-policy') || '');
  ok('预览页含草稿内容', (await previewPage.text()).includes('鲜肉包'));
  ok('预览【没有】改动活动发布指针',
    rows('SELECT active_release_id FROM public_content_state')[0].active_release_id === activeBefore);
  const tampered = await fetch(BASE + preview.body.preview_url.replace(/.$/, 'X'));
  ok('被篡改的预览令牌拿不到内容', tampered.status === 404 || tampered.status === 410, String(tampered.status));

  // ── 发布工作流 ────────────────────────────────────────────────────────────
  const scheduledReview = (await api('/api/admin/publication/draft-snapshot?effective_at_sgt=2099-01-01T10:00')).body;
  const scheduled = await api('/api/admin/publication/schedule', { method: 'POST', body: {
    base_revision: scheduledReview.draft_revision, expected_active_release_id: scheduledReview.active.release_id, expected_draft_checksum: scheduledReview.draft.checksum, effective_at_sgt: '2099-01-01T10:00' } });
  ok('可以排程一个未来发布', scheduled.status === 200 && !!scheduled.body?.release_id, JSON.stringify(scheduled.body).slice(0, 80));
  ok('排程【不】改活动指针',
    rows('SELECT active_release_id FROM public_content_state')[0].active_release_id === activeBefore);

  const cancelled = await api('/api/admin/publication/cancel', { method: 'POST', body: { release_id: scheduled.body.release_id } });
  ok('未来发布可以取消', cancelled.status === 200, String(cancelled.status));

  const publishReview = (await api('/api/admin/publication/draft-snapshot')).body;
  const publishNow = await api('/api/admin/publication/publish-now', { method: 'POST', body: {
    base_revision: publishReview.draft_revision, expected_active_release_id: publishReview.active.release_id, expected_draft_checksum: publishReview.draft.checksum } });
  ok('立即发布成功', publishNow.status === 200 && !!publishNow.body?.release_id, JSON.stringify(publishNow.body).slice(0, 80));
  const activeAfter = rows('SELECT active_release_id FROM public_content_state')[0].active_release_id;
  ok('活动指针指向刚发布的版本', activeAfter === publishNow.body.release_id);
  ok('标签进入了发布的商品行',
    JSON.parse(rows(`SELECT tags_json FROM public_content_release_products WHERE release_id='${activeAfter}' AND sku='S01'`)[0].tags_json)
      .some(t => t.id === 'chef-pick'));

  const beforeRollbackCount = rows('SELECT COUNT(*) AS n FROM public_content_releases')[0].n;
  const noBaseline = await api('/api/admin/publication/rollback', { method: 'POST', body: { release_id: activeBefore } });
  ok('旧回滚入口缺核对版本返回409', noBaseline.status === 409, String(noBaseline.status));
  const staleRollback = await api('/api/admin/publication/rollback', { method: 'POST', body: { release_id: activeBefore, expected_active_release_id: activeBefore } });
  ok('旧回滚入口旧线上版本返回409', staleRollback.status === 409, String(staleRollback.status));
  ok('两个被拒回滚均零写且线上不变', rows('SELECT COUNT(*) AS n FROM public_content_releases')[0].n === beforeRollbackCount
    && rows('SELECT active_release_id FROM public_content_state')[0].active_release_id === activeAfter);
  const rolled = await api('/api/admin/publication/rollback', { method: 'POST', body: { release_id: activeBefore, expected_active_release_id: activeAfter } });
  ok('可以回滚到某个历史发布', rolled.status === 200 && rolled.body?.release_id !== activeAfter, JSON.stringify(rolled.body).slice(0, 80));
  ok('任何时刻只有一个 published',
    rows("SELECT COUNT(*) AS n FROM public_content_releases WHERE status='published'")[0].n === 1);
  ok('回滚完整snapshot恢复至真正历史版本', rows(`SELECT snapshot_json FROM public_content_releases WHERE id='${rolled.body.release_id}'`)[0].snapshot_json
    === rows(`SELECT snapshot_json FROM public_content_releases WHERE id='${activeBefore}'`)[0].snapshot_json);
}

main()
  .catch(e => { fails.push('运行时异常: ' + e.message); console.error(e); })
  .finally(async () => {
    if (child) child.kill('SIGTERM');
    await sleep(500);
    rmSync(persist, { recursive: true, force: true });
    console.log(`\n通过 ${pass}，失败 ${fails.length}`);
    if (fails.length) console.log('失败：', fails.join('、'));
    // wrangler 的本地代理和 puppeteer 的子进程会吊住事件循环：macOS 上碰巧退了，
    // Linux CI 上会一直挂到 job 超时 —— 一个 93/0 全绿的套件因此变成红叉。
    setTimeout(() => process.exit(fails.length ? 1 : 0), 500);
  });
