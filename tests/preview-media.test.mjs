import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../worker/index.js';
import {signPreviewToken} from '../worker/publication.js';
import {createSqliteD1} from './sqlite-d1.mjs';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const HASH=createHash('sha256').update(PNG).digest('hex');
const ORIGIN='https://shop.example';
async function fixture(){
 const DB=createSqliteD1();
 DB.sqlite.exec('DELETE FROM product_tag_assignments; DELETE FROM products; DELETE FROM homepage_posters;');
 DB.sqlite.prepare('INSERT INTO products(sku,name_cn,name_en,price,category,active,sort,img) VALUES(?,?,?,?,?,?,?,?)')
  .run('S01','测试原图包','Preview image bun',3.6,'protein',1,1,'data:image/png;base64,'+PNG.toString('base64'));
 const env={DB,AUTH_SECRET:'preview-media-test-secret',ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
 const revision=DB.query('SELECT draft_revision FROM public_content_state WHERE singleton=1')[0].draft_revision;
const token=await signPreviewToken(env.AUTH_SECRET,{draftRevision:revision,expiresAt:new Date(Date.now()+600000).toISOString(),nonce:'media-test'});
 const ctx={waitUntil(){assert.fail('Preview must not enqueue cache writes');}};
 const get=(p)=>worker.fetch(new Request(ORIGIN+p),env,ctx);
 return {DB,env,token,get};
}
test('private draft preview shows and serves the uploaded original without publication writes',async()=>{
 const f=await fixture();
 try{
  const page=await f.get(`/preview/${f.token}/menu/s01`);assert.equal(page.status,200);
  const html=await page.text();const mediaPath=`/preview/${f.token}/media/${HASH}`;
  assert.ok(html.includes(mediaPath),'rendered preview must reference the original draft media');
  assert.equal(page.headers.get('cache-control'),'private, no-store');
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  const image=await f.get(mediaPath);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),PNG);
  assert.equal(image.headers.get('cache-control'),'private, no-store');
  assert.equal(image.headers.get('referrer-policy'),'no-referrer');
  assert.equal(f.DB.query('SELECT COUNT(*) n FROM public_media')[0].n,0);
  assert.equal(f.DB.query('SELECT COUNT(*) n FROM public_content_releases')[0].n,0);
  const missing=await f.get(`/preview/${f.token}/media/${'0'.repeat(64)}`);assert.equal(missing.status,404);
 }finally{f.DB.sqlite.close();}
});
test('preview image requires a valid unexpired token and current draft revision',async()=>{
 const f=await fixture();try{
  assert.notEqual((await f.get(`/preview/invalid/media/${HASH}`)).status,200);
  f.DB.sqlite.exec("UPDATE public_content_state SET draft_revision='later-edit' WHERE singleton=1");
  assert.equal((await f.get(`/preview/${f.token}/media/${HASH}`)).status,409);
 }finally{f.DB.sqlite.close();}
});
test('draft mutation during preview loading cannot slip past its revision check',async()=>{
 const f=await fixture();try{
  f.DB.beforeBatch(/SELECT sku,name_cn/,()=>f.DB.sqlite.exec("UPDATE public_content_state SET draft_revision='concurrent-edit' WHERE singleton=1"));
  const response=await f.get(`/preview/${f.token}/menu/s01`);
  assert.equal(response.status,409);
 }finally{f.DB.sqlite.close();}
});
test('a signed future preview contains exactly that date’s posters and original media',async()=>{
 const f=await fixture();try{
  f.DB.sqlite.prepare(`INSERT INTO homepage_posters(id,title_cn,title_en,body_cn,body_en,badge,image_data,image_url,image_version,
    action_type,action_value,cta_cn,cta_en,active,show_on_open,show_on_home,sort,starts,ends,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('future','未来活动独有标题','Future-only offer','','','',
      'data:image/png;base64,'+PNG.toString('base64'),'','v1','none','','','',1,1,1,1,'2099-01-01','2099-01-01','2026-09-12','2026-09-12');
  const revision=f.DB.query('SELECT draft_revision FROM public_content_state')[0].draft_revision;
  const token=await signPreviewToken(f.env.AUTH_SECRET,{draftRevision:revision,expiresAt:new Date(Date.now()+600000).toISOString(),
    nonce:'future-test',contentAt:'2099-01-01T02:00:00.000Z'});
  const future=await f.get(`/preview/${token}/`);assert.equal(future.status,200);
  const html=await future.text();assert.ok(html.includes('未来活动独有标题'));
  const current=await f.get(`/preview/${f.token}/`);assert.equal(current.status,200);
  assert.ok(!(await current.text()).includes('未来活动独有标题'));
  const image=await f.get(`/preview/${token}/media/${HASH}`);assert.equal(image.status,200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),PNG);
  assert.equal(f.DB.query('SELECT COUNT(*) n FROM public_media')[0].n,0);
 }finally{f.DB.sqlite.close();}
});
