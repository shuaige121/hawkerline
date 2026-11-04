// worker/public-render.js
// 把一个不可变的发布快照渲染成【原始可爬取】的 HTML/JSON/XML。
// 这里只读快照，不读 D1、不读草稿 —— 所以同一个 release 永远渲染出同一份字节。
import {serializeJsonScript} from './publication.js';

// 站点 origin 随快照发布（settings.public_origin，来自 SHOP_DOMAIN），渲染不读环境变量。
const originOf=release=>{
  const raw=String(release?.settings?.public_origin||'');
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(raw)?raw.replace(/\/$/,''):'';
};
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const money=cents=>`S$${(Number(cents)/100).toFixed(2)}`;
const priceText=cents=>(Number(cents)/100).toFixed(2);
const canonicalPath=path=>path==='/'?'/' : path.replace(/\/$/,'');
const safePublicUrl=value=>{
  const text=String(value||'');
  if (/^\/(?:public\/media\/[0-9a-f]{64}|img\/[a-z0-9_./-]+)$/i.test(text)) return text;
  if (/^img\/[a-z0-9_./-]+$/i.test(text)) return `/${text}`;
  try { const url=new URL(text); return url.protocol==='https:'&&!url.username&&!url.password?url.toString():''; }
  catch { return ''; }
};
async function sha256Text(value) {
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return [...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

const brandCn=release=>String(release.settings?.brand_name_cn||release.settings?.brand_name_en||'我的餐厅');
const brandEn=release=>String(release.settings?.brand_name_en||(release.settings?.brand_name_cn?'':'My Restaurant'));
// 分类显示名来自发布快照里的 menu_categories（店主或 agent 配置）；找不到就显示 key 本身。
const categoryLabel=(release,key)=>{
  const list=Array.isArray(release.settings?.menu_categories)?release.settings.menu_categories:[];
  const hit=list.find(c=>c&&c.key===key);
  return hit?[hit.cn,hit.en].filter(Boolean).join(' '):String(key);
};

// 共享的客户外壳：header / 语言与会员入口 / 购物车与结账对话框。
// 浏览器测试依赖这些稳定选择器，渲染页与 web/index.html 必须保持一致。
// 共享客户外壳 —— 与 web/index.html 的 <body> 逐个选择器对齐。
// 浏览器测试、购物车、结账、会员面板都依赖这些 id/class，渲染页不能是"爬虫特供"的简版。
function shell(release,{main,mainId='menu',beforeMain=''}) {
  const contact=String(release.settings?.shop_contact_phone||'').replace(/[^0-9]/g,'');
  const wa=contact.length===8?`65${contact}`:contact;
  const brand=[brandCn(release),brandEn(release)].filter(Boolean).join(' ');
  const year=String(release.published_at||'').slice(0,4)||String(new Date().getUTCFullYear());
  return `${wa?`<a id="helpFab" class="help-fab" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>`:''}
<header>
  <img src="${esc(safePublicUrl(release.settings?.brand_logo)||'/img/logo.svg')}" alt="${esc(brandCn(release))}">
  <div style="flex:1"><div class="b">${esc(brand)}</div><div class="s" id="subtitle">${esc(release.settings?.brand_slogan_cn||'')}</div></div>
  <button id="langBtn" onclick="setLang(L==='cn'?'en':'cn')" style="background:transparent;color:var(--on-primary,#F4E7C8);border:1px solid var(--on-primary,#F4E7C8);border-radius:18px;padding:10px 14px;font-weight:700;font-size:13px;margin-right:8px">EN</button>
  <button id="memberBtn" style="background:var(--gold2);color:var(--green-text,var(--green));border:none;border-radius:18px;padding:10px 16px;font-weight:700;font-size:13px">会员</button>
</header>

<div id="closedBanner"></div>
<div id="posterRail" class="poster-rail" style="display:none"></div>
<div id="orderProgress"></div>
<div id="routeBanner"></div>
<div id="deliveryInfo"></div>
<div id="topupPromo"></div>
<div id="pickupHome"></div>
${beforeMain}
<main id="${esc(mainId)}">${main}</main>

<div class="bar">
  <div class="t"><span id="totalLabel">合计</span> <b id="total">S$ 0.00</b> <span class="muted" id="count">0 件</span></div>
  <button id="checkout" disabled>去结算</button>
</div>

<div class="sheet" id="sheet"><div class="panel" id="sheetBody"></div></div>
<div class="sheet" id="memberSheet"><div class="panel" id="memberBody"></div></div>
<div class="sheet" id="wxSheet"><div class="panel" id="wxBody"></div></div>
<div id="posterModal" class="poster-modal" aria-hidden="true"><div id="posterDialog" class="poster-dialog" role="dialog" aria-modal="true" aria-labelledby="posterDialogTitle"></div></div>
<div id="posterToast" class="poster-toast" role="status" aria-live="polite"></div>
<footer style="text-align:center;padding:20px 16px 32px;font-size:12px;color:#6E6650;border-top:1px solid #E4D9BE;background:#F6EFE0;margin-top:24px">
  <a href="/privacy" style="color:#1C4A3A;font-weight:700;text-decoration:none">隐私政策 Privacy</a>
  &nbsp;·&nbsp;
  <a href="/terms" style="color:#1C4A3A;font-weight:700;text-decoration:none">条款 Terms</a>
  &nbsp;·&nbsp;
  <a href="/about" style="color:#1C4A3A;font-weight:700;text-decoration:none">关于我们 About Us</a><br>
  ${wa?`<a id="footerWa" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener" style="color:#1C4A3A;font-weight:700;text-decoration:none">WhatsApp</a>
  &nbsp;·&nbsp;
  <a id="footerTel" href="tel:+${esc(wa)}" style="color:#1C4A3A;font-weight:700;text-decoration:none">一键拨号 Call</a><br>`:''}
  <span style="opacity:.8">© ${esc(year)} ${esc(brand)}</span>
</footer>`;
}

function document({release,path,title,description,body,structuredData,mainId,beforeMain}) {
  const canonical=`${originOf(release)}${canonicalPath(path)}`;
  const publicJson=serializeJsonScript(release);
  const ld=serializeJsonScript(structuredData);
  return `<!doctype html><html lang="zh-SG" data-public-release="${esc(release.release_id)}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<link rel="icon" href="/img/logo.svg">
<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">
<script defer src="/vendor/leaflet/leaflet.js"></script>
<link rel="stylesheet" href="/storefront.css">
<link rel="canonical" href="${esc(canonical)}"><meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}">
<script type="application/ld+json">${ld}</script></head>
<body>${shell(release,{main:body,mainId,beforeMain})}<script id="hl-public-data" type="application/json">${publicJson}</script>
<script defer src="/storefront.js"></script></body></html>`;
}

function productCard(product) {
  const tags=(product.tags||[]).map(t=>`<span class="tag tag-${esc(t.tone)}">${esc(t.icon)} ${esc(t.label_cn)}<small>${esc(t.label_en)}</small></span>`).join('');
  return `<article class="product" data-sku="${esc(product.sku)}"><a href="/menu/${esc(product.slug)}">
<img src="${esc(safePublicUrl(product.image_url)||'/img/product-fallback.svg')}" alt="${esc(product.name_cn)} ${esc(product.name_en)}" loading="lazy">
<h2>${esc(product.name_cn)} <small>${esc(product.name_en)}</small></h2>${product.contents_cn?`<p class="contents">含：${esc(product.contents_cn)}</p>`:''}<p>${esc(product.description_cn)}</p>
<p class="price">${money(product.price_cents)}</p>${tags}</a><button type="button" data-add-sku="${esc(product.sku)}">加入购物车</button></article>`;
}

// ── JSON-LD ────────────────────────────────────────────────────────────────
// 扁平 @graph：每个实体都是顶层节点，用 @id 互相引用。
// 只发布【已核实】的事实 —— 没有评分、评价、菜系、库存状态。
function organizationNodes(release) {
  const ORIGIN=originOf(release);
  const address=String(release.settings?.shop_address||'');
  return [
    {'@type':'Organization','@id':`${ORIGIN}/#organization`,name:brandCn(release),
      alternateName:brandEn(release),url:`${ORIGIN}/`},
    {'@type':'FoodEstablishment','@id':`${ORIGIN}/#establishment`,name:brandCn(release),
      url:`${ORIGIN}/`,parentOrganization:{'@id':`${ORIGIN}/#organization`},
      ...(address?{address:{'@type':'PostalAddress',streetAddress:address,addressCountry:'SG'}}:{})},
  ];
}

function menuNodes(release) {
  const ORIGIN=originOf(release);
  const products=(release.products||[]).filter(p=>p.active);
  const categories=[...new Set(products.map(p=>String(p.category||'other')))];
  const sectionId=category=>`${ORIGIN}/menu#section-${encodeURIComponent(category)}`;
  const itemId=product=>`${ORIGIN}/menu/${product.slug}#item`;
  const offerId=product=>`${ORIGIN}/menu/${product.slug}#offer`;
  return [
    {'@type':'Menu','@id':`${ORIGIN}/menu#menu`,name:`${brandCn(release)} 菜单`,url:`${ORIGIN}/menu`,
      hasMenuSection:categories.map(c=>({'@id':sectionId(c)}))},
    ...categories.map(category=>({'@type':'MenuSection','@id':sectionId(category),name:categoryLabel(release,category),
      hasMenuItem:products.filter(p=>String(p.category||'other')===category).map(p=>({'@id':itemId(p)}))})),
    ...products.map(product=>({'@type':'MenuItem','@id':itemId(product),name:product.name_cn,
      alternateName:product.name_en||undefined,description:product.description_cn||undefined,
      image:safePublicUrl(product.image_url)?`${ORIGIN}${safePublicUrl(product.image_url)}`:undefined,
      url:`${ORIGIN}/menu/${product.slug}`,offers:{'@id':offerId(product)}})),
    ...products.map(product=>({'@type':'Offer','@id':offerId(product),
      price:priceText(product.price_cents),priceCurrency:'SGD',url:`${ORIGIN}/menu/${product.slug}`})),
  ];
}

const graph=nodes=>({'@context':'https://schema.org','@graph':nodes});

// ── 页面 ────────────────────────────────────────────────────────────────────
export function renderHomePage(release) {
  const products=(release.products||[]).filter(p=>p.active);
  const offers=(release.offers||[]).filter(o=>o.active&&o.show_on_home);
  // h1 与优惠区放在 <main id="menu"> 之【外】：注水时 render() 会重写 #menu，
  // 放在里面的话，爬虫看得到 h1、真人注水后反而没有了。
  const beforeMain=`<section class="hero"><h1>${esc(brandCn(release))} <small>${esc(brandEn(release))}</small></h1>
${release.settings?.brand_slogan_cn?`<p>${esc(release.settings.brand_slogan_cn)}</p>`:''}</section>
${offers.length?`<section class="offers"><h2>正在进行的优惠</h2>${offers.map(o=>
  `<article class="offer" data-offer="${esc(o.id)}"><h3>${esc(o.title_cn)} <small>${esc(o.title_en)}</small></h3>
<p>${esc(o.body_cn)}</p></article>`).join('')}</section>`:''}`;
  const main=`<h2>今日菜单</h2>${products.map(productCard).join('')}`;
  return document({release,path:'/',beforeMain,title:`${brandCn(release)} ${brandEn(release)}`,
    description:`${brandCn(release)} 的公开菜单、价格、自取点与优惠。`,body:main,
    structuredData:graph(organizationNodes(release))});
}

export function renderMenuPage(release) {
  const products=(release.products||[]).filter(p=>p.active);
  const categories=[...new Set(products.map(p=>String(p.category||'other')))];
  const beforeMain=`<section class="hero"><h1>菜单 Menu</h1></section>`;
  const main=`${categories.map(category=>
    `<section class="menu-section" id="${esc(categoryAnchorId(category))}" data-category="${esc(category)}"><h2>${esc(categoryLabel(release,category))}</h2>
${products.filter(p=>String(p.category||'other')===category).map(productCard).join('')}</section>`).join('')}`;
  return document({release,path:'/menu',beforeMain,title:`菜单 · ${brandCn(release)}`,
    description:`${brandCn(release)} 全部在售商品、价格与说明。`,body:main,
    structuredData:graph(menuNodes(release))});
}

// 与 web/storefront.js 的 categoryAnchorId 同一规则：/menu#cat-<key> 注水前后都能跳到同一分类。
function categoryAnchorId(category) {
  return `cat-${String(category).toLowerCase().replace(/[^a-z0-9_-]+/g,'-')}`;
}

// 不在活动发布里的 /menu/<slug>（改名、下架、或还没发布的新品）：状态码仍是 404，
// 但给顾客一条回菜单的路。不读快照、不嵌 storefront.js、不带加购 —— 不能暗示这个商品存在、即将上架或售罄。
// 样式内联：不依赖 storefront.css 的版本，新旧静态资源下显示一致。
export function renderMissingProductPage() {
  return `<!doctype html><html lang="zh-SG"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>商品暂不可用 Item unavailable</title>
<link rel="icon" href="/img/logo.svg">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:32px 18px;font-family:system-ui,'Noto Sans CJK SC',sans-serif;color:#33301F;background:#F6EFE0}
.missing{width:100%;max-width:480px;text-align:center;background:#FBF7EC;border:1px solid #D8B45F;border-radius:18px;padding:28px 22px;box-shadow:0 8px 24px rgba(28,74,58,.10)}
.missing img{width:72px;height:72px;border-radius:50%}
.brand{margin:8px 0 0;color:#1C4A3A;font-size:15px;font-weight:800;letter-spacing:1px}
h1{margin:18px 0 4px;color:#1C4A3A;font-size:22px;line-height:1.35}
.lead{margin:0 0 12px;color:#1C4A3A;font-size:17px;font-weight:700;line-height:1.4}
p{margin:6px 0;font-size:14px;line-height:1.65;color:#6E6650}
.actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:20px}
.actions a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border-radius:24px;font-size:15px;font-weight:800;text-decoration:none}
.actions .primary{background:#1C4A3A;color:#F4E7C8}
.actions .secondary{background:#fff;color:#1C4A3A;border:1px solid #1C4A3A}
</style></head>
<body><main class="missing">
<img src="/img/logo.svg" alt="">
<h1>这个商品暂时不在菜单上</h1>
<p class="lead" lang="en">This item isn’t on our menu right now</p>
<p>链接可能已失效，或这个商品目前没有上架。请返回菜单查看目前在售的商品。</p>
<p lang="en">The link may be out of date, or the item isn’t listed at the moment. Please head back to the menu to see what’s available.</p>
<nav class="actions"><a class="primary" href="/menu">返回菜单 · Back to menu</a><a class="secondary" href="/">回到首页 · Home</a></nav>
</main></body></html>`;
}

export function renderProductPage(release,product) {
  const tags=(product.tags||[]).map(t=>`<span class="tag tag-${esc(t.tone)}">${esc(t.icon)} ${esc(t.label_cn)}</span>`).join('');
  const main=`<article class="product-detail" data-sku="${esc(product.sku)}">
<img src="${esc(safePublicUrl(product.image_url)||'/img/product-fallback.svg')}" alt="${esc(product.name_cn)} ${esc(product.name_en)}">
<h1>${esc(product.name_cn)} <small>${esc(product.name_en)}</small></h1>
<p class="price">${money(product.price_cents)}</p>${tags}
${product.contents_cn?`<p class="contents">含：${esc(product.contents_cn)}</p><p class="contents-en" lang="en">Incl: ${esc(product.contents_en)}</p>`:''}
<p class="description">${esc(product.description_cn)}</p><p class="description-en">${esc(product.description_en)}</p>
<div class="detail">${esc(product.detail_cn)}</div><div class="detail-en">${esc(product.detail_en)}</div>
${product.kcal?`<p class="kcal">${esc(product.kcal)} kcal</p>`:''}
<button type="button" data-add-sku="${esc(product.sku)}">加入购物车</button></article>`;
  return document({release,mainId:'productDetail',path:`/menu/${product.slug}`,
    title:`${product.name_cn} ${product.name_en} · ${brandCn(release)}`,
    description:product.description_cn||`${product.name_cn} ${money(product.price_cents)}`,body:main,
    structuredData:graph(menuNodes({...release,products:[product]}))});
}

export function renderLocationsPage(release) {
  // pickup_display 由 parsePublishableSettings 生成，已经剔除停用点，且含内置主店。
  const points=Array.isArray(release.settings?.pickup_display)
    ?release.settings.pickup_display.filter(p=>p.id!=='main')
    :[];
  const hasAddress=!!String(release.settings?.shop_address||'').trim();
  const main=`<h1>自取点 Pickup locations</h1>
${!hasAddress&&!points.length?'<p class="empty">自取点信息尚未公布，请在结账时查看。</p>':''}
<section class="kitchen"><h2>${esc(brandCn(release))}</h2><p class="address">${esc(release.settings?.shop_address||'')}</p>
<p class="address-en">${esc(release.settings?.shop_address_en||'')}</p>
<p class="detail">${esc(release.settings?.shop_pickup_detail||'')}</p></section>
${points.map(point=>`<section class="pickup-point" data-point="${esc(point.id)}">
<h2>${esc(point.name||point.name_cn||'')} <small>${esc(point.name_en||'')}</small></h2>
<p class="address">${esc(point.address||'')}</p><p class="detail">${esc(point.detail||'')}</p></section>`).join('')}`;
  return document({release,mainId:'locationsPage',path:'/locations',title:`自取点 · ${brandCn(release)}`,
    description:`${brandCn(release)} 的厨房与全部自取点地址。`,body:main,
    structuredData:graph(organizationNodes(release))});
}

export function renderOffersPage(release) {
  const offers=(release.offers||[]).filter(o=>o.active);
  const main=`<h1>优惠 Offers</h1>${offers.length?offers.map(o=>
    `<article class="offer" data-offer="${esc(o.id)}"><h2>${esc(o.title_cn)} <small>${esc(o.title_en)}</small></h2>
${o.badge?`<span class="badge">${esc(o.badge)}</span>`:''}
<p>${esc(o.body_cn)}</p><p class="en">${esc(o.body_en)}</p>
${o.starts||o.ends?`<p class="period">${esc(o.starts||'')} – ${esc(o.ends||'')}</p>`:''}
${o.action_type==='product'?`<a href="/menu/${esc(String(o.action_value).toLowerCase())}">${esc(o.cta_cn||'去看看')}</a>`:''}</article>`).join('')
    :'<p>暂时没有进行中的优惠。</p>'}`;
  return document({release,mainId:'offersPage',path:'/offers',title:`优惠 · ${brandCn(release)}`,
    description:`${brandCn(release)} 正在进行的公开优惠。`,body:main,
    structuredData:graph(organizationNodes(release))});
}

export function renderSitemap(release) {
  const ORIGIN=originOf(release);
  const lastmod=String(release.published_at||'').slice(0,10);
  const paths=['/','/menu','/locations','/offers',
    ...(release.products||[]).filter(p=>p.active).map(p=>`/menu/${p.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map(path=>`<url><loc>${esc(ORIGIN+canonicalPath(path))}</loc>${lastmod?`<lastmod>${esc(lastmod)}</lastmod>`:''}</url>`).join('\n')}
</urlset>`;
}

export function renderRobots(release) {
  const ORIGIN=originOf(release);
  const disallow=['/admin','/pos','/kitchen','/preview/','/invoice/','/api/','/auth/','/member/',
    '/order/','/orders/','/pay/','/payment/','/webhook/','/webhooks/','/public/preview/'];
  const allowPublic=['Allow: /$','Allow: /menu','Allow: /locations','Allow: /offers',
    'Allow: /public/catalog.json','Allow: /public/media/'];
  const block=agent=>[`User-agent: ${agent}`,...allowPublic,...disallow.map(path=>`Disallow: ${path}`),''].join('\n');
  return [block('*'),block('Googlebot'),block('OAI-SearchBot'),block('GPTBot'),
    ...(ORIGIN?[`Sitemap: ${ORIGIN}/sitemap.xml`]:[]),''].join('\n');
}

export async function renderPublicReleasePages(release) {
  const active=(release.products||[]).filter(p=>p.active);
  // 【一次性】算出公开投影，然后每一个面都用它。
  // 之前只有 / 和 /menu 过滤了下架商品，而 /locations、/offers、商品详情页
  // 以及两份 catalog.json 拿到的是未过滤的 release —— 每个页面又把整个 release
  // 嵌进 #hl-public-data，等于把未上市/已撤商品直接发给爬虫。
  // 停用的自取点同理：只发 pickup_display（已过滤），不发原始 pickup_points。
  const publicSettings={...(release.settings||{})};
  delete publicSettings.pickup_points;
  const publicRelease={...release,products:active,settings:publicSettings};
  const pages=[
    {path:'/',contentType:'text/html; charset=utf-8',body:renderHomePage(publicRelease)},
    {path:'/menu',contentType:'text/html; charset=utf-8',body:renderMenuPage(publicRelease)},
    {path:'/locations',contentType:'text/html; charset=utf-8',body:renderLocationsPage(publicRelease)},
    {path:'/offers',contentType:'text/html; charset=utf-8',body:renderOffersPage(publicRelease)},
    ...active.map(p=>({path:`/menu/${p.slug}`,contentType:'text/html; charset=utf-8',body:renderProductPage(publicRelease,p)})),
    {path:'/public/catalog.json',contentType:'application/json; charset=utf-8',body:JSON.stringify(publicRelease)},
    {path:`/public/releases/${release.release_id}/catalog.json`,contentType:'application/json; charset=utf-8',body:JSON.stringify(publicRelease)},
    {path:'/sitemap.xml',contentType:'application/xml; charset=utf-8',body:renderSitemap(publicRelease)},
    {path:'/robots.txt',contentType:'text/plain; charset=utf-8',body:renderRobots(publicRelease)},
  ];
  return Promise.all(pages.map(async page=>({...page,etag:`"${await sha256Text(page.body)}"`})));
}
