// worker/public-cache.js
import {ensureActiveRelease} from './publication.js';
import {validatePublicImageBytes,normalizePublicMediaBytes} from './public-media.js';
import {renderPublicReleasePages} from './public-render.js';
const PUBLIC_PATH=/^(?:\/|\/menu\/?|\/menu\/[a-z0-9_-]+\/?|\/locations\/?|\/offers\/?|\/public\/catalog\.json|\/public\/releases\/[a-z0-9_-]+\/catalog\.json|\/sitemap\.xml|\/robots\.txt)$/;
export const classifyPublicPath=url=>PUBLIC_PATH.test(new URL(url).pathname);
export const isAuthenticatedPublicRequest=request=>Boolean(request.headers.get('authorization')||request.headers.get('cookie'));

export function publicCacheKey(request) {
  const url=new URL(request.url); url.hostname=url.hostname.toLowerCase().replace(/^www\./,''); url.search='';
  if (url.pathname.length>1) url.pathname=url.pathname.replace(/\/$/,'');
  return new Request(url.toString(),{method:'GET'});
}

const MUTABLE_BROWSER_CACHE='no-store, max-age=0';
const MUTABLE_EDGE_CACHE='public, max-age=60';
function mutablePublicResponse(response) {
  const out=new Response(response.body,response);
  out.headers.set('cache-control',MUTABLE_BROWSER_CACHE);
  out.headers.set('cloudflare-cdn-cache-control',MUTABLE_EDGE_CACHE);
  return out;
}
function edgeCacheResponse(response) {
  const out=new Response(response.body,response);
  // Cache API needs a cacheable copy; browser responses are normalized on every hit.
  out.headers.set('cache-control',MUTABLE_EDGE_CACHE);
  out.headers.set('cloudflare-cdn-cache-control',MUTABLE_EDGE_CACHE);
  return out;
}

export async function servePublicPage(request,env,ctx,{cache=caches.default}={}) {
  const key=publicCacheKey(request);
  const authenticated=isAuthenticatedPublicRequest(request);
  const path=new URL(key.url).pathname;
  const versionMatch=path.match(/^\/public\/releases\/([a-z0-9_-]+)\/catalog\.json$/);
  let hit=null;
  try { hit=await cache.match(key); } catch(error) { console.error('public cache read failed',error); }
  if (hit) {
    const normalized=versionMatch?hit:mutablePublicResponse(hit);
    return authenticated?privateResponse(normalized):normalized;
  }
  let page;
  if (versionMatch) {
    page=await env.DB.prepare(`SELECT p.body,p.content_type,p.etag,p.release_id
      FROM public_content_release_pages p WHERE p.release_id=? AND p.path=?`)
      .bind(versionMatch[1],path).first();
  } else {
    const recovery=await ensureActiveRelease(env,{actor:'system:request-recovery',allowBootstrap:false,
      pageBuilder:renderPublicReleasePages}); // cache miss only
    if (!recovery?.active_release_id) {
      const error=new Error('bootstrap pending'); error.code='bootstrap_pending'; throw error;
    }
    page=await env.DB.prepare(`SELECT p.body,p.content_type,p.etag,r.id AS release_id
      FROM public_content_state s JOIN public_content_releases r ON r.id=s.active_release_id
      JOIN public_content_release_pages p ON p.release_id=r.id
      WHERE s.singleton=1 AND p.path=?`).bind(path).first();
  }
  if (!page) return null;
  const versioned=Boolean(versionMatch);
  let response=new Response(page.body,{headers:{'content-type':page.content_type,etag:page.etag,
    'cache-control':'public, max-age=31536000, immutable','x-public-release':page.release_id}});
  if (!versioned) response=mutablePublicResponse(response);
  if (authenticated) return privateResponse(response);
  const cacheCopy=versioned?response.clone():edgeCacheResponse(response.clone());
  ctx.waitUntil(Promise.resolve().then(()=>cache.put(key,cacheCopy))
    .catch(error=>console.error('public cache put failed',error)));
  return response;
}

export async function servePublicMedia(request,env,ctx,{cache=caches.default}={}) {
  const url=new URL(request.url); const match=url.pathname.match(/^\/public\/media\/([0-9a-f]{64})$/);
  if (!match) return null;
  const hash=match[1], key=new Request(`https://${new URL(request.url).hostname.toLowerCase().replace(/^www\./,'')}/public/media/${hash}`), authenticated=isAuthenticatedPublicRequest(request);
  let hit=null;
  try { hit=await cache.match(key); } catch(error) { console.error('public media cache read failed',error); }
  if (hit) return authenticated?privateResponse(hit):hit;
  const row=await env.DB.prepare('SELECT content_type,body,byte_length FROM public_media WHERE hash=?').bind(hash).first();
  const bytes=normalizePublicMediaBytes(row?.body);
  const digest=bytes?new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)):null;
  const actualHash=digest?[...digest].map(byte=>byte.toString(16).padStart(2,'0')).join(''):'';
  if (!row||!bytes||bytes.byteLength!==Number(row.byte_length)||actualHash!==hash||!validatePublicImageBytes(row.content_type,bytes)) {
    console.error('public media missing or invalid',hash);
    return new Response('Not found',{status:404,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }
  const response=new Response(bytes,{headers:{'content-type':row.content_type,'content-length':String(bytes.byteLength),
    etag:`"${hash}"`,'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'}});
  if (authenticated) return privateResponse(response);
  ctx.waitUntil(Promise.resolve().then(()=>cache.put(key,response.clone()))
    .catch(error=>console.error('public media cache put failed',error)));
  return response;
}

export function privateResponse(response) {
  const out=new Response(response.body,response); out.headers.set('cache-control','private, no-store');
  out.headers.delete('cloudflare-cdn-cache-control');
  out.headers.set('x-robots-tag','noindex, nofollow, noarchive'); return out;
}

// 旧客户端（POS / 已登录页面）兼容投影：只读不可变发布表，永远不读 products。
// 一条查询拿到 release_id + 全部在售商品，字段名保持与旧 /api/menu 一致。
export async function activeReleaseMenuProjection(env) {
  const {results}=await env.DB.prepare(
    `SELECT r.id AS release_id,p.sku,p.name_cn,p.name_en,p.price_cents,p.category,p.kcal,
            p.image_url,p.description_cn,p.description_en,p.detail_cn,p.detail_en,p.tags_json,
            json_extract(r.snapshot_json,'$.settings.menu_categories') AS menu_categories
       FROM public_content_state s
       JOIN public_content_releases r ON r.id=s.active_release_id
       JOIN public_content_release_products p ON p.release_id=r.id
      WHERE s.singleton=1 AND p.active=1
      ORDER BY p.sort,p.sku`).all();
  const rows=results||[];
  const releaseId=rows.length?rows[0].release_id:null;
  let categories=[];
  try { categories=rows.length?JSON.parse(rows[0].menu_categories||'[]'):[]; } catch { categories=[]; }
  return {
    release_id:releaseId,
    menu_revision:releaseId,
    categories:Array.isArray(categories)?categories:[],
    products:rows.map(row=>({
      sku:row.sku,name_cn:row.name_cn,name_en:row.name_en,
      price_cents:row.price_cents,
      price:Math.round(row.price_cents)/100,          // legacy field kept for old POS clients
      category:row.category,kcal:row.kcal,
      img:row.image_url,image_url:row.image_url,
      description_cn:row.description_cn,description_en:row.description_en,
      detail_cn:row.detail_cn,detail_en:row.detail_en,
      tags:(()=>{try{return JSON.parse(row.tags_json||'[]');}catch(e){return [];}})(),
    })),
  };
}
