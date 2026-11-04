// tests/public-render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPublicReleasePages} from '../worker/public-render.js';

const release={release_id:'rel-1',checksum:'abc',published_at:'2026-08-29T14:30:00.000Z',
  settings:{brand_name_cn:'示例点心铺',brand_name_en:'Demo Dim Sum',shop_address:'10 Test Rd, Singapore 123456',public_origin:'https://shop.example'},
  products:[{sku:'S01',slug:'s01',name_cn:'鲜肉包',name_en:'Pork Bun',price_cents:360,
    category:'protein',description_cn:'每日现包',description_en:'Made fresh daily',detail_cn:'肉汁丰富',detail_en:'Juicy filling',
    image_url:'/public/media/'+'a'.repeat(64),active:1,sort:1,tags:[{id:'fresh-meat',label_cn:'纯鲜肉',label_en:'Fresh meat',tone:'red',icon:'🥩'}]}],offers:[]};
const releaseWithPickupAndOffer=()=>({...release,
  settings:{...release.settings,pickup_points:[{id:'main',name_cn:'中央厨房',name_en:'Central Kitchen',address:'10 Test Rd, Singapore 123456',active:1}]},
  offers:[{id:'launch',title_cn:'新品上架',title_en:'New arrival',body_cn:'本周供应',body_en:'Available this week',active:1,show_on_home:1,sort:1}],
});

test('all public facts exist in raw HTML and unsafe content is escaped', async () => {
  const pages=await renderPublicReleasePages(release);
  const byPath=new Map(pages.map(p=>[p.path,p]));
  for (const path of ['/','/menu','/menu/s01','/locations','/offers','/public/catalog.json','/public/releases/rel-1/catalog.json','/sitemap.xml','/robots.txt']) assert.ok(byPath.has(path), path);
  const home=byPath.get('/').body;
  assert.match(home, /鲜肉包/); assert.match(home, /S\$3\.60/); assert.match(home, /纯鲜肉/);
  assert.match(home, /data-public-release="rel-1"/);
  assert.match(home, /<link rel="canonical" href="https:\/\/shop\.example\/"/);
  assert.match(home, /application\/ld\+json/); assert.match(home, /id="hl-public-data"/);
  assert.match(home, /name="twitter:card"/);
  assert.doesNotMatch(home, /data:image/);
  assert.match(byPath.get('/menu/s01').body, /每日现包/);
  assert.match(byPath.get('/locations').body, /10 Test Rd/);
  assert.match(byPath.get('/sitemap.xml').body, /https:\/\/shop\.example\/menu\/s01/);
  assert.match(byPath.get('/robots.txt').body, /Sitemap: https:\/\/shop\.example\/sitemap\.xml/);
  assert.match(byPath.get('/robots.txt').body, /User-agent: OAI-SearchBot/);
  assert.match(byPath.get('/robots.txt').body, /Disallow: \/invoice\//);
  assert.equal(JSON.parse(byPath.get('/public/catalog.json').body).release_id,'rel-1');
});

test('JSON-LD contains only the required verified public entities', async () => {
  const pages=await renderPublicReleasePages(releaseWithPickupAndOffer());
  const documents=pages.filter(page=>page.contentType.startsWith('text/html'));
  const nodes=documents.flatMap(page=>[...page.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)])
    .flatMap(match=>{ const value=JSON.parse(match[1]); return value['@graph']||[value]; });
  const types=new Set(nodes.flatMap(node=>Array.isArray(node['@type'])?node['@type']:[node['@type']]));
  for (const type of ['Organization','FoodEstablishment','Menu','MenuSection','MenuItem','Offer']) assert.ok(types.has(type),type);
  for (const offer of nodes.filter(node=>(Array.isArray(node['@type'])?node['@type']:[node['@type']]).includes('Offer'))) {
    assert.equal(offer.priceCurrency,'SGD');
    assert.match(String(offer.price),/^\d+\.\d{2}$/);
    assert.match(String(offer.url),/^https:\/\/shop\.example\//);
  }
  const serialized=JSON.stringify(nodes);
  assert.doesNotMatch(serialized,/aggregateRating|review|servesCuisine|availability/);
});

test('delisted products and disabled pickup points never reach any public surface', async () => {
  const leaky = {
    release_id:'rel-leak', checksum:'abc', published_at:'2026-08-29T14:30:00.000Z',
    settings:{
      brand_name_cn:'示例点心铺', shop_address:'10 Test Rd, Singapore 123456',
      // 未过滤的原始清单里有一个【已停用】的点：它绝不能出现在任何公开面上
      pickup_points:[{id:'closed-partner',active:0,name:'已结束的合作点',address:'99 Secret Rd',photo:''}],
      pickup_display:[{id:'main',active:1,name:'示例点心铺',address:'10 Test Rd, Singapore 123456',photo:''}],
    },
    products:[
      {sku:'S01',slug:'s01',name_cn:'鲜肉包',name_en:'Pork Bun',price_cents:360,category:'protein',
        description_cn:'每日现包',image_url:'/img/01.png',active:1,sort:1,tags:[]},
      {sku:'SECRET9',slug:'secret9',name_cn:'未上市新品',name_en:'Unlaunched',price_cents:999,category:'protein',
        description_cn:'还没上',image_url:'/img/02.png',active:0,sort:2,tags:[]},
    ],
    offers:[],
  };
  const pages = await renderPublicReleasePages(leaky);
  for (const page of pages) {
    assert.ok(!page.body.includes('SECRET9'), `${page.path} 泄露了下架商品 SKU`);
    assert.ok(!page.body.includes('未上市新品'), `${page.path} 泄露了下架商品名`);
    assert.ok(!page.body.includes('99 Secret Rd'), `${page.path} 泄露了停用自取点地址`);
    assert.ok(!page.body.includes('已结束的合作点'), `${page.path} 泄露了停用自取点名称`);
  }
  // 下架商品也不该有自己的详情页
  assert.ok(!pages.some(p => p.path === '/menu/secret9'), '下架商品不应有详情页');
  // 在售的仍然在
  assert.ok(pages.find(p => p.path === '/').body.includes('鲜肉包'));
  assert.ok(pages.some(p => p.path === '/menu/s01'));
});

test('an empty brand uses the storefront brand, never the pickup venue name', async () => {
  const fixture={...release,settings:{...release.settings,brand_name_cn:'',brand_name_en:'',shop_name:'Example Food Court'}};
  const pages=await renderPublicReleasePages(fixture);
  const menu=pages.find(p=>p.path==='/menu').body;
  assert.match(menu,/<title>菜单 · 我的餐厅<\/title>/);
  assert.doesNotMatch(menu,/<title>[^<]*Example Food Court/);
  assert.match(menu,/我的餐厅 My Restaurant/);
});
