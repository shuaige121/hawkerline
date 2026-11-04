let L = localStorage.getItem('hl_lang') || 'cn';
const T = {
  cn: { sub:'', member:'会员', total:'合计', items:'件', checkout:'去结算',
    confirm:'确认订单', fulfil:'取餐方式', pickup:'自取 Pickup', delivery:'配送 Delivery (+S$4)', addr:'配送地址', addrPh:'Blk / 街道 / 单元',
    name:'姓名', namePh:'您的称呼', phone:'WhatsApp 手机号', placeOrder:'下单并获取 PayNow 付款',
    noteLabel:'特殊要求', noteHint:'(可选)', notePh:'例如：少辣、不要香菜、单独打包',
    submitting:'提交中…', orderNote:'下单后将生成 PayNow 收款码与发票；付款后我们通过 WhatsApp 发送确认。',
    needNamePhone:'请填写姓名和手机号', orderFail:'下单失败：', payTitle:'请用 PayNow 付款', payNo:'单号', payAmt:'金额', payTo:'转账至 PayNow UEN',
    payRefTip:'付款备注请填写：', viewInvoice:'查看 / 保存发票', payAuto:'付款后系统将自动确认，并通过 WhatsApp 发送发票。',
    memberTitle:'会员中心 · 积分', memberHint:'输入手机号查看积分与历史。下单付款后每 S$1 累计 1 分。', query:'查询', querying:'查询中…',
    noOrders:'暂无订单', curPoints:'当前积分', spent:'累计消费', ordersU:'单', recentOrders:'最近订单', paid:'已付', unpaid:'待付', queryFail:'查询失败：', loading:'加载菜单中…',
    promoLabel:'优惠码（可选）', promoPh:'输入优惠码', apply:'应用', useBalance:'自动使用储值余额', balanceAutoHint:'登录后自动显示余额并优先抵扣商品金额；如需保留余额可取消勾选。', balanceLabel:'储值余额', discountLine:'优惠', balancePay:'余额抵扣', dueNow:'应付',
    topup:'充值', topupTitle:'会员储值充值', topupHint:'充得多送得多，余额仅可在本店消费。', topupGo:'去充值', paidOk:'✓ 已用余额支付', termsLink:'条款与细则', agreeTerms:'下单即代表同意',
    login:'登录', register:'注册', logout:'退出登录', password:'密码', forgot:'忘记密码？', google:'用 Google 登录', apple:'用 Apple 登录', or:'或', getCode:'获取验证码', code:'验证码', newPass:'新密码', resetPass:'重置密码', loginFirst:'登录会员账户', setPwHint:'首次使用请设置密码（至少6位）', welcome:'欢迎', birthday:'生日', saveProfile:'保存资料', profileSaved:'已保存',
    route:'拼单顺路送', routePick:'选择拼单路线', cutoff:'截单', postal:'邮编', lookup:'查询', unitNo:'房号 / 单元号', routeBanner:'🛵 拼单顺路送 · 运费更省', routeHint:'顺路拼单，运费比单独叫便宜很多', routeToday:'📍 今日拼单路线', routeJoin:'一起拼单 →',
    closedTitle:'🍽️ 小店暂停接单', closedMsg:'我们正在备货 / 休息中，稍后再来看看哦～', closedShort:'暂停接单',
    deliveryWord:'配送', minOrder:'起送', freeDeliv:'免运费',
    progTitle:'订单进度', progNew:'📝 已下单，等待接单', progPreparing:'👨‍🍳 制作中', progReadyPickup:'🎉 可取餐啦！请到店取餐', progReadyDeliv:'🎉 已出餐，正在为您配送', progDone:'✅ 已完成，谢谢惠顾',
    progPickupWord:'到店自取', progDeliveryWord:'配送', progWhen:'预约', progDelay:'预计延迟', progMin:'分钟',
    progArrive:'🙋 我到店了', progArriving:'告知中…', progArrived:'✓ 已告诉店家你到了，请稍候', progArriveBusy:'点太快啦，请稍后再试', progArriveFail:'暂时无法通知店家，请稍后再试或直接找店员',
    wxTitle:'微信里打不开登录', wxWhy:'微信内置浏览器会拦截 Google / Apple 登录页面。请按下面的方法，用手机自带浏览器打开本页再登录。',
    wxIos:'点右上角「···」→ 选择「在 Safari 中打开」，然后再点登录。',
    wxAndroid:'点右上角「···」→ 选择「在浏览器打开」，然后再点登录。',
    wxCopy:'复制本页链接', wxCopied:'✓ 已复制，去浏览器粘贴打开', wxCopyFail:'复制失败，请长按上面的网址手动复制', wxClose:'知道了',
    wxGuest:'不想登录也没关系：直接选商品下单即可，会员登录只是用来看积分和储值余额。',
    walletNoBalance:'余额明细暂时无法核对，请联系本店核对余额。',
    svTitle:'会员储值 · 充值越多送越多', svHint:'线上付款自动入账，余额和每笔变动都可在会员中心查看。', svFine:'登录后充值；储值仅可支付商品，不含配送费。' },
  en: { sub:'', member:'Member', total:'Total', items:'items', checkout:'Checkout',
    confirm:'Confirm Order', fulfil:'Fulfilment', pickup:'Pickup', delivery:'Delivery (+S$4)', addr:'Delivery Address', addrPh:'Blk / Street / Unit',
    name:'Name', namePh:'Your name', phone:'WhatsApp Phone', placeOrder:'Place order & pay via PayNow',
    noteLabel:'Special request', noteHint:'(optional)', notePh:'e.g. less spicy, no cilantro, pack separately',
    submitting:'Submitting…', orderNote:'A PayNow QR & invoice will be generated; we confirm via WhatsApp after payment.',
    needNamePhone:'Please enter name and phone', orderFail:'Order failed: ', payTitle:'Pay via PayNow', payNo:'Invoice', payAmt:'Amount', payTo:'Transfer to PayNow UEN',
    payRefTip:'Payment reference:', viewInvoice:'View / Save invoice', payAuto:'Payment auto-confirmed; invoice sent via WhatsApp.',
    memberTitle:'Member · Points', memberHint:'Enter your phone to see points & history. Earn 1 point per S$1 paid.', query:'Check', querying:'Loading…',
    noOrders:'No orders yet', curPoints:'Points', spent:'Total spent', ordersU:'orders', recentOrders:'Recent orders', paid:'Paid', unpaid:'Unpaid', queryFail:'Query failed: ', loading:'Loading menu…',
    promoLabel:'Promo code (optional)', promoPh:'Enter code', apply:'Apply', useBalance:'Use stored value automatically', balanceAutoHint:'Your balance is shown after sign-in and applied to products automatically. Uncheck to keep it.', balanceLabel:'Balance', discountLine:'Discount', balancePay:'Balance', dueNow:'Due now',
    topup:'Top up', topupTitle:'Member top-up', topupHint:'More top-up, more bonus. Balance usable only in-store.', topupGo:'Top up now', paidOk:'✓ Paid by balance', termsLink:'Terms & Conditions', agreeTerms:'By ordering you agree to the',
    login:'Log in', register:'Sign up', logout:'Log out', password:'Password', forgot:'Forgot password?', google:'Sign in with Google', apple:'Sign in with Apple', or:'or', getCode:'Get code', code:'Code', newPass:'New password', resetPass:'Reset password', loginFirst:'Member login', setPwHint:'First time? Set a password (min 6 chars)', welcome:'Welcome', birthday:'Birthday', saveProfile:'Save profile', profileSaved:'Saved',
    route:'Group route', routePick:'Pick a group route', cutoff:'Cutoff', postal:'Postal code', lookup:'Look up', unitNo:'Unit no.', routeBanner:'🛵 Group delivery route · cheaper', routeHint:'Order along the route — much cheaper than solo delivery', routeToday:"📍 Today's group route", routeJoin:'Join order →',
    closedTitle:'🍽️ Ordering paused', closedMsg:'We are restocking / on a break — please check back soon.', closedShort:'Closed',
    deliveryWord:'Delivery', minOrder:'min', freeDeliv:'free delivery',
    progTitle:'Order progress', progNew:'📝 Order placed — awaiting confirmation', progPreparing:'👨‍🍳 Being prepared in the kitchen', progReadyPickup:'🎉 Ready! Please collect at the shop', progReadyDeliv:'🎉 Out of the kitchen — on the way to you', progDone:'✅ Completed — thank you!',
    progPickupWord:'Pickup', progDeliveryWord:'Delivery', progWhen:'Scheduled', progDelay:'Delayed by', progMin:'min',
    progArrive:"🙋 I'm here", progArriving:'Notifying…', progArrived:'✓ The shop knows you have arrived', progArriveBusy:'Too many taps — please try again shortly', progArriveFail:'Could not notify the shop — please try again or ask our staff',
    wxTitle:'Sign-in does not work inside WeChat', wxWhy:'The WeChat in-app browser blocks Google / Apple sign-in pages. Open this page in your phone browser first, then sign in.',
    wxIos:'Tap "···" at the top right → choose "Open in Safari", then tap sign in again.',
    wxAndroid:'Tap "···" at the top right → choose "Open in Browser", then tap sign in again.',
    wxCopy:'Copy this page link', wxCopied:'✓ Copied — paste it into your browser', wxCopyFail:'Copy failed — please long-press the link above to copy it', wxClose:'Got it',
    wxGuest:'No account needed: you can order as a guest. Signing in is only for points and stored value.',
    walletNoBalance:'Running balance is temporarily unavailable — please contact the shop to verify your balance.',
    svTitle:'Member stored value · top up and earn bonuses', svHint:'Online payments credit automatically; see your balance and every transaction in Member.', svFine:'Sign in to top up. Stored value covers products, not delivery fees.' },
};
const t = k => T[L][k];
const pname = p => L === 'en' ? (p.name_en || p.name_cn) : p.name_cn;
const pdesc = p => L === 'en' ? (p.description_en || p.description_cn || '') : (p.description_cn || p.description_en || '');
const pdetail = p => L === 'en' ? (p.detail_en || p.detail_cn || '') : (p.detail_cn || p.detail_en || '');
// 组成文字由发布快照生成（与厨房出餐同一份组成），这里只加前缀显示
const pcontents = p => { const s = L === 'en' ? (p.contents_en || p.contents_cn || '') : (p.contents_cn || p.contents_en || ''); return s ? (L === 'en' ? 'Incl: ' : '含：') + s : ''; };
window.setLang = (l) => {
  L = l; localStorage.setItem('hl_lang', l);
  document.getElementById('langBtn').textContent = l === 'cn' ? 'EN' : '中';
  document.getElementById('subtitle').textContent = brandSlogan() || t('sub');
  renderMemberButton();
  document.getElementById('totalLabel').textContent = t('total');
  document.getElementById('checkout').textContent = t('checkout');
  document.documentElement.lang = l === 'en' ? 'en' : 'zh';
  renderRouteBanner();
  render();
  renderContactSurfaces();
  applyStoreState();
  renderProgress();   // 进度卡文案也跟着切语言
  renderTopupPromo();
  renderHomepagePosters();
  renderOpeningPoster();
};
const cart = Object.create(null);   // sku -> {p, qty}
// created_at 存的是 UTC ISO；展示 +8h 转 SGT 日期，与单号营业日(ORD-YYYYMMDD)一致，避免 SGT 0-8 点差一天。
const sgtDate = (iso) => iso ? new Date(new Date(iso).getTime() + 480 * 60000).toISOString().slice(0, 10) : '';
const sgtDateTime = (iso) => iso ? new Date(new Date(iso).getTime() + 480 * 60000).toISOString().slice(0, 16).replace('T', ' ') : '';
let PRODUCTS = [];
let POSTERS = [];
let OPEN_POSTER_ID = '';
const POSTER_SEEN_KEY = 'hl_opening_poster_seen';
const POSTER_SESSION_SHOWN_KEY = 'hl_opening_poster_shown';
const POSTER_PROMO_KEY = 'hl_poster_promo';

let ROUTES = [];
// runtime store config (open/closed + delivery rules); defaults keep the site usable if /api/config fails
let CONFIG = { store_open: true, store_closed_msg: '', pickup_enabled: true, delivery: { enabled: true, fee: 4, min: 0, free_above: 0, note: '', areas: '' }, shop: { name: '', address: '', detail: '', photo: '', points: [] }, contact: { digits: '', display: '', tel_href: '', whatsapp_href: '' }, pricing: { gst_registered: false, gst_rate: 9, service_charge_enabled: false, service_charge_rate: 10 } };
let CATEGORIES = [];   // [{key, cn, en}] from the published release (owner/agent configurable)
let BRAND = null;    // boss-configurable branding (logo/slogan/colors) from /api/config; empty fields keep built-in defaults
function brandSlogan() { if (!BRAND) return ''; return (L === 'en') ? (BRAND.slogan_en || BRAND.slogan_cn || '') : (BRAND.slogan_cn || BRAND.slogan_en || ''); }
// 品牌主色亮度 → 自适应文字色：浅底自动切深字（深底保持原浅字，默认行为不变），杜绝老板选亮色致品牌区文字看不清
function onPrimaryText(hex) {
  const c = String(hex).replace('#', ''); const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (!/^[0-9a-fA-F]{6}$/.test(n)) return '';
  const lin = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [R, G, B] = [0, 2, 4].map(i => lin(parseInt(n.slice(i, i + 2), 16) / 255));
  const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;   // WCAG 相对亮度
  const cr = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return cr(L, 0.013) > cr(L, 0.79) ? '#1a1a1a' : '';   // 深字 vs 浅奶油字，取对比更高者；'' = 保持 CSS 原浅字
}
function applyBrand() {
  if (!BRAND) return;
  const r = document.documentElement.style;
  if (BRAND.color_primary) { r.setProperty('--green', BRAND.color_primary); const op = onPrimaryText(BRAND.color_primary); if (op) { r.setProperty('--on-primary', op); r.setProperty('--green-text', op); } else { r.removeProperty('--on-primary'); r.removeProperty('--green-text'); } }   // --green-text: 主色当文字(贴白/浅底)时太浅则切深字,深色品牌保留色相
  if (BRAND.color_secondary) { r.setProperty('--gold', BRAND.color_secondary); r.setProperty('--gold2', BRAND.color_secondary); }
  if (BRAND.color_bg) { r.setProperty('--cream', BRAND.color_bg); r.setProperty('--cream2', BRAND.color_bg); }
  if (BRAND.color_accent) r.setProperty('--red', BRAND.color_accent);
  if (BRAND.logo) { const lg = document.querySelector('header img'); if (lg) lg.src = BRAND.logo; const fav = document.querySelector('link[rel=icon]'); if (fav) fav.href = BRAND.logo; }
  if (BRAND.name_cn || BRAND.name_en) { const nm = document.querySelector('header .b'); if (nm) nm.textContent = `${BRAND.name_cn || ''} ${BRAND.name_en || ''}`.trim(); }
  const previousBrand = HL_RELEASE?.settings?.shop_name;
  if (!HL_RELEASE?.settings?.brand_name_cn && previousBrand) {
    const suffix = ` · ${previousBrand}`;
    if (document.title.endsWith(suffix)) document.title = document.title.slice(0, -suffix.length) + ` · ${BRAND.name_cn}`;
    else if (document.title === `${previousBrand} ${BRAND.name_en}`) document.title = `${BRAND.name_cn} ${BRAND.name_en}`;
  }
  const sub = document.getElementById('subtitle'); const sl = brandSlogan(); if (sub && sl) sub.textContent = sl;
  const fb = document.getElementById('footerBrand');
  if (fb && (BRAND.name_cn || BRAND.name_en)) fb.textContent = `© ${new Date().getFullYear()} ${`${BRAND.name_cn || ''} ${BRAND.name_en || ''}`.trim()}`;
}
let DCFG = null;     // 3-tier + postal zones from /api/delivery-config
let ZONE = null;     // resolved 优惠配送 zone for the entered postal (null = none → anytime)
let ANY_FEE = 0;     // latest 自费随时送/本店配送 运费报价
let ANY_BLOCKED = false;  // true = 该地址算不出运费（不允许下单，必须改自取）
let _autoAddr = '';       // 上一次由邮编自动带出的路名。邮编一改就作废，防「改了邮编、街道还留着上一个地址」被当成成交地址发给司机
let _orderTok = null;
let _orderAttempted = false;   // 该 client_token 是否已经提交过：重试不再做停业预检
let _acceptedRevision = null;  // 顾客【显式确认过】的新发布版本；绝不自动接受     // 下单幂等令牌：失败重试沿用同令牌（后端按 client_token 去重，防双击/重试重复建单+重复扣余额）
let _cartRevision = null;
// 顾客确认新版本时核对过的商品。之后再加进购物车的商品没看过新价格/新组成，必须按页面版本重新提交，让服务端再列一次差异。
let _acceptedSkus = new Set();
const acceptedRevisionForCart = () => (_acceptedRevision && Object.keys(cart).every(sku => _acceptedSkus.has(sku)) ? _acceptedRevision : null);
let _submitBusy = false;
let _menuChangesMessage = '';
function saveCart() {
  const entries = Object.entries(cart);
  if (!entries.length) { _cartRevision = null; _acceptedRevision = null; _acceptedSkus = new Set(); _menuChangesMessage = ''; }
  else if (!_cartRevision) _cartRevision = window.HL_MENU_REVISION;
  try {
    // Keep the existing quantity-only format for old clients; context preserves the prices the customer saw across pages/releases.
    localStorage.setItem('hl_cart', JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, v.qty]))));
    if (entries.length) localStorage.setItem('hl_cart_context', JSON.stringify({ revision: _cartRevision, products: Object.fromEntries(entries.map(([k, v]) => [k, v.p])), unavailable: entries.filter(([, v]) => v.unavailable).map(([k]) => k) }));
    else localStorage.removeItem('hl_cart_context');
  } catch (e) {}
}
// 下单成功后必须调这个：清内存、清 localStorage、重画菜单和底栏。
// 只清内存不清 localStorage 的话，顾客一刷新购物车又满了。
function clearCart() {
  Object.keys(cart).forEach(k => delete cart[k]);
  saveCart();
  try { render(); } catch (e) {}
}
function restoreCart() {
  try {
    const saved = JSON.parse(localStorage.getItem('hl_cart') || '{}');
    let context;
    try { context = JSON.parse(localStorage.getItem('hl_cart_context') || 'null'); } catch (e) {}
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    const revision = typeof context?.revision === 'string' && /^[a-z0-9_-]{1,80}$/i.test(context.revision) ? context.revision : null;
    for (const [sku, qty] of Object.entries(saved)) {
      if (!Number.isInteger(qty) || qty <= 0) continue;
      const previous = revision && context?.products?.[sku];
      const validPrevious = previous?.sku === sku && Number.isSafeInteger(previous.price_cents) && previous.price_cents >= 0
        && typeof previous.name_cn === 'string' && typeof previous.name_en === 'string';
      const current = PRODUCTS.find(x => x.sku === sku);
      const p = validPrevious ? { ...previous, price: previous.price_cents / 100 } : current;
      if (p) cart[sku] = { p, qty: Math.min(99, qty), unavailable: !current || (Array.isArray(context?.unavailable) && context.unavailable.includes(sku)) };
      else if (/^[a-z0-9_-]{1,64}$/i.test(sku)) cart[sku] = { p: { sku, name_cn: sku, name_en: sku, price: 0, price_cents: 0 }, qty: Math.min(99, qty), unavailable: true };
    }
    // Old clients did not save prices or a revision. An unknown revision forces the server's explicit review path.
    if (Object.keys(cart).length) _cartRevision = revision || 'unversioned-cart';
  } catch (e) {}
}
const WDAYS = (en) => en ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] : ['周日','周一','周二','周三','周四','周五','周六'];
function zoneBySector(postal) { if (!DCFG || !DCFG.zones) return null; const d = String(postal||'').replace(/\D/g,''); if (d.length < 2) return null; const sec = d.slice(0,2); return DCFG.zones.find(z => z.sectors.includes(sec)) || null; }
function weekdayOfStr(s) { return new Date(s + 'T12:00:00').getDay(); }
function localDateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function sgtNowParts(now = new Date()) {
  const sgt = new Date(now.getTime() + 480 * 60000);
  return { date:sgt.toISOString().slice(0,10), dow:sgt.getUTCDay(), hhmm:String(sgt.getUTCHours()).padStart(2,'0') + ':' + String(sgt.getUTCMinutes()).padStart(2,'0'), shifted:sgt };
}
function nextBusinessSlotClient(now = new Date()) {
  const schedule = CONFIG.business_hours && CONFIG.business_hours.schedule;
  if (!schedule) return null;
  const cur = sgtNowParts(now), toMin = value => { const [h,m] = String(value).split(':').map(Number); return h * 60 + m; };
  const toHHMM = value => `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
  const todayWin = schedule[cur.dow];
  if (Array.isArray(todayWin) && cur.hhmm >= todayWin[0] && cur.hhmm < todayWin[1]) return null;
  for (let offset=0; offset<14; offset++) {
    const day = new Date(cur.shifted); day.setUTCDate(day.getUTCDate() + offset);
    const win = schedule[day.getUTCDay()];
    if (!Array.isArray(win) || win.length !== 2) continue;
    if (offset === 0 && cur.hhmm >= win[1]) continue;
    const ready = toMin(win[0]) + Math.max(0, +(CONFIG.prep_time_min ?? 20));
    if (ready >= toMin(win[1])) continue;
    return { date:day.toISOString().slice(0,10), time:toHHMM(ready), dow:day.getUTCDay() };
  }
  return null;
}
function autoScheduleCheckoutIfNeeded() {
  const ff = document.querySelector('[name=ff]:checked')?.value;
  const di = document.getElementById('date'), ti = document.getElementById('time'), msg = document.getElementById('autoScheduleMsg');
  if (!di || !ti || !msg || !['pickup','anytime'].includes(ff) || di.value || ti.value) return false;
  const slot = nextBusinessSlotClient(); if (!slot) { msg.textContent = ''; return false; }
  di.value = slot.date; ti.value = slot.time; updateTimeConstraints(); onDateChange();
  msg.textContent = L === 'en'
    ? `Automatically scheduled for ${WDAYS(true)[slot.dow]} ${slot.date} at ${slot.time} (next opening).`
    : `已自动安排到 ${slot.date}（${WDAYS(false)[slot.dow]}）${slot.time}，即下一次营业可取/送达时间。`;
  return true;
}
function nextZoneDate(zone) {
  const schedule = CONFIG.business_hours && CONFIG.business_hours.schedule;
  for (let i = 0; i < 21; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const dow = d.getDay(), shopOpen = !schedule || Array.isArray(schedule[dow]);
    if (zone.weekdays.includes(dow) && shopOpen) return d;
  }
  return null;
}
// ── 发布注水 ────────────────────────────────────────────────────────────────
// 页面自带 <script id="hl-public-data">：菜单、价格、标签、海报、自取点、
// 配送规则、储值档位全部来自不可变发布快照。正常浏览【零】固定内容请求。
const HL_RELEASE = (() => {
  const node = document.getElementById('hl-public-data');
  if (!node) return null;
  try { return JSON.parse(node.textContent); } catch (e) { console.error('public release payload unreadable', e); return null; }
})();
window.HL_PUBLIC_RELEASE = HL_RELEASE;
window.HL_MENU_REVISION = HL_RELEASE && HL_RELEASE.release_id || null;
function isPreviewPage() { return location.pathname.startsWith('/preview/') || String(window.HL_MENU_REVISION || '').startsWith('preview-'); }
function menuHref() { const prefix = location.pathname.match(/^\/preview\/[^/]+/); return prefix ? `${prefix[0]}/menu` : '/menu'; }

// 同源图片一律用绝对路径：子路由下相对路径会解析错。
function publicAssetUrl(value) {
  const url = String(value || '');
  if (!url) return '/img/product-fallback.svg';
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('/')) return url;
  return '/' + url;
}
window.publicAssetUrl = publicAssetUrl;

function publicProduct(sku) {
  if (!HL_RELEASE) return null;
  return (HL_RELEASE.products || []).find(item => item.sku === sku && item.active) || null;
}
window.publicProduct = publicProduct;

function sgtNowPartsClient(now = new Date()) {
  const sgt = new Date(now.getTime() + 8 * 3600000);
  return { dow: sgt.getUTCDay(), hhmm: String(sgt.getUTCHours()).padStart(2, '0') + ':' + String(sgt.getUTCMinutes()).padStart(2, '0') };
}
// 营业时段表来自发布快照（服务端已按同一规则解析），这里只判断"此刻在不在时段内"。
function businessHoursNow(schedule) {
  if (!schedule) return { schedule: null, open_now: true, today: null, dow: sgtNowPartsClient().dow };
  const { dow, hhmm } = sgtNowPartsClient();
  const today = schedule[dow] || null;
  return { schedule, open_now: !!(today && hhmm >= today[0] && hhmm < today[1]), today, dow };
}

function hydrateFromRelease() {
  if (!HL_RELEASE) { PRODUCTS = []; POSTERS = []; TOPUP_TIERS = []; return; }
  const s = HL_RELEASE.settings || {};
  PRODUCTS = (HL_RELEASE.products || []).filter(p => p.active).map(p => ({
    sku: p.sku, slug: p.slug, name_cn: p.name_cn, name_en: p.name_en,
    price: Math.round(p.price_cents) / 100, price_cents: p.price_cents,
    category: p.category, kcal: p.kcal, img: p.image_url,
    description_cn: p.description_cn, description_en: p.description_en,
    detail_cn: p.detail_cn, detail_en: p.detail_en, tags: p.tags || [],
    contents_cn: p.contents_cn || '', contents_en: p.contents_en || '',
  }));
  POSTERS = (HL_RELEASE.offers || []).filter(o => o.active);
  TOPUP_TIERS = (s.topup_tiers || []).slice().sort((a, b) => a[0] - b[0]).map(([amount, bonus]) => ({ amount, bonus }));
  DCFG = s.delivery || null;
  CONFIG = {
    // store_open 是【易变】状态，不在发布里：默认按开张渲染，只在结账三个时刻向服务端确认。
    store_open: CONFIG.store_open !== false,
    store_closed_msg: CONFIG.store_closed_msg || '',
    pickup_enabled: (s.pickup_display || []).length > 0,
    delivery: {
      enabled: s.delivery_enabled !== '0',
      fee: (s.delivery_fee != null && s.delivery_fee !== '') ? +s.delivery_fee : 4,
      min: +s.delivery_min || 0,
      free_above: +s.delivery_free_above || 0,
      note: s.delivery_note || '', areas: s.delivery_areas || '',
    },
    brand: {
      logo: s.brand_logo || '', name_cn: s.brand_name_cn || s.brand_name_en || '', name_en: s.brand_name_en || '',
      slogan_cn: s.brand_slogan_cn || '', slogan_en: s.brand_slogan_en || '',
      color_primary: s.brand_color_primary || '', color_secondary: s.brand_color_secondary || '',
      color_bg: s.brand_color_bg || '', color_accent: s.brand_color_accent || '',
    },
    refund_max_days: +s.refund_max_days || 0,
    business_hours: businessHoursNow(s.business_hours_schedule),
    shop: {
      name: s.shop_name || '', address: s.shop_address || (s.SHOP_POSTAL ? `S(${s.SHOP_POSTAL})` : ''),
      detail: s.shop_pickup_detail || '', postal: s.SHOP_POSTAL || '',
      photo: s.shop_pickup_photo || '',
      address_en: s.shop_address_en || '', detail_en: s.shop_pickup_detail_en || '',
      points: s.pickup_display || [],
    },
    contact: publicContactClient(s.shop_contact_phone),
    pricing: {
      gst_registered: s.gst_registered === '1', gst_rate: +s.gst_rate || 9,
      service_charge_enabled: s.service_charge_enabled === '1', service_charge_rate: +s.service_charge_rate || 10,
    },
    prep_time_min: Math.min(180, Math.max(0, s.prep_time_min == null || s.prep_time_min === '' ? 20 : Number(s.prep_time_min))),
  };
  BRAND = CONFIG.brand;
  CATEGORIES = Array.isArray(s.menu_categories) ? s.menu_categories.filter(c => c && c.key) : [];
}

function publicContactClient(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return { digits: '', local: '', display: '', tel_href: '', whatsapp_href: '' };
  if (digits.length === 8) digits = '65' + digits;
  const local = digits.startsWith('65') ? digits.slice(2) : digits;
  const display = digits.startsWith('65') && local.length === 8
    ? `+65 ${local.slice(0, 4)} ${local.slice(4)}` : '+' + digits;
  return { digits, local, display, tel_href: 'tel:+' + digits, whatsapp_href: 'https://wa.me/' + digits };
}

// 首页专用表面（海报 / 储值卡 / 取餐点）只在有商品网格的页面出现。
// 商品详情、自取点、优惠页共用同一个外壳，但把这些卡片堆在上面会把
// 页面真正的主体挤到一屏之外 —— 截图验收时一眼就看出来了。
const isGridPage = () => !!document.getElementById('menu');

// V02：首屏先见食物。旧物化发布页的顺序是 海报→配送→储值→取餐点→菜单，而部署代码不会重渲染活动发布，
// 所以在注水时调整一次（幂等），旧 HTML 与新渲染页效果相同：
// 状态卡 → 压缩的优惠条 → 配送说明 → 标题 + 开始点餐 → 菜单 → 储值卡 / 取餐点（都保留，挪到菜单之后）。
function arrangeGridPage() {
  const menu = document.getElementById('menu'); if (!menu) return;
  const byId = id => document.getElementById(id);
  const hero = document.querySelector('body > section.hero'), offers = document.querySelector('body > section.offers');
  const status = byId('routeBanner') || byId('orderProgress') || byId('closedBanner');
  if (status && byId('posterRail')) status.after(byId('posterRail'));
  if (byId('deliveryInfo')) (hero || menu).before(byId('deliveryInfo'));
  let start = byId('orderStart');
  if (!start) { start = document.createElement('section'); start.id = 'orderStart'; start.className = 'order-start'; }
  menu.before(start);
  menu.after(...[offers, byId('topupPromo'), byId('pickupHome')].filter(Boolean));
}
function renderOrderStart() {
  // 发布页的 hero 标语是原始 HTML 里的中文；英文界面换成页头同一句英文标语（老板没填英文就不动）
  const heroSlogan = document.querySelector('body > section.hero p');
  if (heroSlogan && brandSlogan()) heroSlogan.textContent = brandSlogan();
  const el = document.getElementById('orderStart'); if (!el) return;
  const prices = PRODUCTS.map(p => +p.price).filter(v => v > 0);
  if (!prices.length) { el.innerHTML = ''; return; }
  // 360px 英文下三项必须排在一行：次要入口文案保持短，免得换行把第一张商品卡挤出首屏
  const en = L === 'en', from = Math.min(...prices).toFixed(2);
  el.innerHTML = `<a class="order-start-cta" href="#menu">${en ? 'Start order ↓' : '开始点餐 ↓'}</a>
    <span class="order-start-from">${en ? `From <b>S$${from}</b>` : `<b>S$${from}</b> 起`}</span>
    ${TOPUP_TIERS && TOPUP_TIERS.length ? `<a class="order-start-topup" href="#topupPromo">${en ? 'Top up' : '储值充值'}</a>` : ''}`;
}
// 吸顶的分类导航贴在页头下方；页头高度随店名、副标语换行而变，所以量真实高度。
function syncHeaderHeight() {
  const header = document.querySelector('header'); if (!header) return;
  document.documentElement.style.setProperty('--hl-header-h', `${Math.ceil(header.getBoundingClientRect().height)}px`);
}
if (window.ResizeObserver && document.querySelector('header')) new ResizeObserver(syncHeaderHeight).observe(document.querySelector('header'));
window.addEventListener('resize', syncHeaderHeight);
// /menu#cat-tea 这类深链：分类在注水时才渲染出来，渲染完再跳一次。
function scrollToMenuHash() {
  const id = location.hash.slice(1);
  if (!/^cat-[a-z0-9_-]+$/.test(id)) return;
  const target = document.getElementById(id); if (target) target.scrollIntoView({ block: 'start' });
}
// V07：滚动时高亮当前分类，并把它滚进横向导航的可见区。
let CAT_NAV_FRAME = 0;
function updateCategoryNav() {
  CAT_NAV_FRAME = 0;
  const nav = document.querySelector('#menu .cat-nav'); if (!nav) return;
  const limit = nav.getBoundingClientRect().bottom + 8;
  let current = '', active = null;
  for (const heading of document.querySelectorAll('#menu .cat[id]')) { if (heading.getBoundingClientRect().top <= limit) current = heading.id; else break; }
  nav.querySelectorAll('a').forEach(a => {
    if (current && a.getAttribute('href') === `#${current}`) { a.setAttribute('aria-current', 'true'); active = a; } else a.removeAttribute('aria-current');
  });
  const track = nav.querySelector('.cat-nav-track');
  if (active && track && track.scrollWidth > track.clientWidth) track.scrollLeft = active.offsetLeft - track.offsetLeft - (track.clientWidth - active.offsetWidth) / 2;
}
window.addEventListener('scroll', () => { if (!CAT_NAV_FRAME) CAT_NAV_FRAME = requestAnimationFrame(updateCategoryNav); }, { passive: true });

async function load() {
  hydrateFromRelease();
  arrangeGridPage();
  applyBrand();
  renderContactSurfaces();
  applyStoreState();
  if (!isPreviewPage()) restoreCart();
  renderRouteBanner();   // ROUTES stays [] → renders nothing (corridor model retired for postal zones)
  render();
  if (isGridPage()) {
    renderTopupPromo();
    renderHomepagePosters();
    syncHeaderHeight();
    scrollToMenuHash();
    maybeShowOpeningPoster();
  }
}
// 是否接单 = 老板手动开 且 在营业时间内（二者任一不满足都算打烊）
function isStoreOpen() { return CONFIG.store_open && (!CONFIG.business_hours || CONFIG.business_hours.open_now); }
function canOrder() { return !isPreviewPage() && CONFIG.store_open !== false; }   // 草稿预览不能下单；仅当前打烊仍可预约
function closedMsgText() {
  const en = L === 'en';
  if (CONFIG.store_open && CONFIG.business_hours && !CONFIG.business_hours.open_now) {   // 时间外打烊：给时段提示
    const t2 = CONFIG.business_hours.today;
    return t2 ? (en ? `Outside business hours (today ${t2[0]}–${t2[1]}).` : `现在不在营业时间（今日 ${t2[0]}–${t2[1]}）`)
              : (en ? 'Closed today.' : '本店今日休息');
  }
  return CONFIG.store_closed_msg || t('closedMsg');
}
// reflect store open/close on the homepage: red banner + disabled checkout when paused
function applyStoreState() {
  const cb = document.getElementById('closedBanner');
  if (cb) {
    if (isPreviewPage()) {
      cb.innerHTML = `<div class="closed-card"><div class="ct">${L === 'en' ? 'Draft preview — ordering is disabled' : '草稿预览，无法下单'}</div></div>`;
    } else if (!CONFIG.store_open) {   // 紧急下线：整站暂停，连预约都不给
      cb.innerHTML = `<div class="closed-card"><div class="ct">${t('closedTitle')}</div><div class="cm">${esc(CONFIG.store_closed_msg || t('closedMsg'))}</div>${contactActionsHtml(L === 'en')}</div>`;
    } else if (CONFIG.business_hours && !CONFIG.business_hours.open_now) {   // 仅当前打烊：仍可预约，温和提示
      cb.innerHTML = `<div class="closed-card" style="background:#FBF3DF;border:1px solid var(--gold2)"><div class="cm" style="color:var(--ink)">${esc(closedMsgText())}<br><b>${L==='en'?'You can still pre-order — pick a time at checkout.':'仍可下单预约——结账时选好取餐/送达时间即可 👇'}</b></div>${contactActionsHtml(L === 'en')}</div>`;
    } else cb.innerHTML = '';
  }
  applyDeliveryInfo();
  renderHomepagePickupPoints();
  updateBar();
}
// 老板在后台维护的「配送说明」（截单时间、配送时段、急单怎么办）此前顾客一个字看不到，
// 只会疑惑为什么选不了送达时间。默认折叠，不占首屏；delivery_areas 那一大段分区表故意不放这里。
function applyDeliveryInfo() {
  const dn = document.getElementById('deliveryInfo'); if (!dn) return;
  const note = (CONFIG.delivery && CONFIG.delivery.note) || '';
  if (!note) { dn.innerHTML = ''; return; }
  const en = L === 'en', ops = opsText(note, en);
  const wasOpen = !!dn.querySelector('details[open]');   // 结账时刷新停业状态会重画这里，别把顾客展开的说明收回去
  dn.innerHTML = `<details class="delivery-info"${wasOpen ? ' open' : ''}>
      <summary>${en ? '🚚 Delivery info' : '🚚 配送说明'}</summary>
      <div class="delivery-info-body">${esc(ops.lines.join('\n'))}</div>
      ${ops.zhOnly ? '<div class="ops-zh-note">Some details are only available in Chinese.</div>' : ''}
    </details>`;
}
// V01：老板后台的配送说明、取餐点说明目前只有中文字段，公开发布里也没有英文列。
// 英文界面按【逐句】对照表翻译：只收录已核对过的原句，时间、费用、规则一个字不改；
// 老板改了措辞、表里没有的句子，原样显示中文并明确标注 —— 宁可显示中文，也不能让英文顾客看不到规则。
// 店主可按需把自己的中文规则句子与英文对照加进来，例如：'每日 16:00 截止次日预订。': 'Next-day orders close at 16:00 daily.'
const OPS_TEXT_EN = {};
const CJK_RE = /[㐀-鿿豈-﫿]/;
// 按句末标点、或后面跟空白的【】标题切句；句内的【自费随时送】这类引用不切开。
const opsSegments = text => String(text || '').split(/(?<=[。！？])\s*|(?<=】)\s+|\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
function opsText(text, en = L === 'en') {
  const raw = String(text || '').trim();
  if (!en || !CJK_RE.test(raw)) return { lines: raw ? [raw] : [], zhOnly: false };
  let zhOnly = false;
  const lines = opsSegments(raw).map(seg => {
    if (!CJK_RE.test(seg)) return seg;
    if (OPS_TEXT_EN[seg]) return OPS_TEXT_EN[seg];
    zhOnly = true;
    return seg;
  });
  return { lines, zhOnly };
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtCutoff(c) {
  if (!c) return '';
  const s = String(c), datePart = s.slice(0, 10), timePart = s.slice(11, 16);
  const d = new Date();
  const todayStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if (datePart === todayStr) return (L === 'en' ? 'Cutoff today ' : '今日截单 ') + timePart;
  return t('cutoff') + ' ' + s.slice(5, 16);
}
let HOME_MAPS = [];
function homePin(emoji) {
  // NB: `L` is the language var on this page; Leaflet lives on window.L
  return window.L.divIcon({ html:`<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">${emoji}</div>`, className:'', iconSize:[22,22], iconAnchor:[11,20] });
}
function renderRouteBanner() {
  const el = document.getElementById('routeBanner'); if (!el) return;
  HOME_MAPS.forEach(m => { try { m.remove(); } catch (e) {} }); HOME_MAPS = [];
  if (!ROUTES.length) { el.innerHTML = ''; return; }
  el.innerHTML = ROUTES.map((r, i) => {
    const areas = (r.areas && r.areas.length) ? r.areas : null;
    const via = areas ? (L === 'en' ? 'Via ' : '途经 ') + areas.join(' → ')
              : (r.blocks ? (L === 'en' ? 'Via ' : '途经 ') + r.blocks : '');
    const note = r.note ? (via ? ' · ' : '') + r.note : '';
    const cut = fmtCutoff(r.cutoff);
    const hasMap = !!(r.geometry && r.geometry.length && window.L && window.L.map);
    return `<div class="route-card">
      <div class="eyebrow">${t('routeToday')}</div>
      <div class="rname">${esc(r.name)}</div>
      ${(via || note) ? `<div class="rsub">${esc(via)}${esc(note)}</div>` : ''}
      <div class="rchips">
        <span class="chip">${L === 'en' ? 'Delivery' : '运费'} S$${(r.fee||0).toFixed(2)}</span>
        ${cut ? `<span class="chip cut">⏰ ${cut}</span>` : ''}
        ${r.distance_m ? `<span class="chip">${(r.distance_m/1000).toFixed(1)} km</span>` : ''}
      </div>
      ${hasMap ? `<div id="routeMap-${i}" class="route-map"></div>` : ''}
      <div class="rcta">
        <span class="rhint">${t('routeHint')}</span>
        <button class="rjoin" onclick="openCheckout('route','${r.id}')">${t('routeJoin')}</button>
      </div>
    </div>`;
  }).join('');
  // draw corridor maps AFTER layout settles (Leaflet needs a sized container)
  const drawMaps = () => {
    const LF = window.L;  // Leaflet (page-level `L` is the language code)
    ROUTES.forEach((r, i) => {
      if (!(r.geometry && r.geometry.length && LF && LF.map)) return;
      const mEl = document.getElementById('routeMap-' + i); if (!mEl) return;
      try {
        const map = LF.map(mEl, { zoomControl:false, scrollWheelZoom:false, attributionControl:true });
        LF.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',
          { minZoom:11, maxZoom:18, attribution:'© OneMap & SLA' }).addTo(map);
        const latlngs = r.geometry.map(([lng, lat]) => [lat, lng]);
        const poly = LF.polyline(latlngs, { color:'#E8C766', weight:5, opacity:.95 }).addTo(map);
        if (r.from_lat != null) LF.marker([r.from_lat, r.from_lng], { icon:homePin('🍽️') }).addTo(map).bindPopup((L === 'en' ? 'Start' : '起点') + ' ' + (r.from_postal||''));
        if (r.to_lat != null) LF.marker([r.to_lat, r.to_lng], { icon:homePin('📍') }).addTo(map).bindPopup((L === 'en' ? 'End' : '终点') + ' ' + (r.to_postal||''));
        map.invalidateSize();
        map.fitBounds(poly.getBounds().pad(0.12));
        HOME_MAPS.push(map);
      } catch (e) { /* map optional; card still works */ }
    });
  };
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => requestAnimationFrame(drawMaps));
  else setTimeout(drawMaps, 80);
}

// Boss-managed campaign cards. Metadata stays small; uploaded art loads lazily.
function pendingPosterPromo() {
  try { return String(sessionStorage.getItem(POSTER_PROMO_KEY) || '').trim().toUpperCase(); } catch (e) { return ''; }
}
function setPendingPosterPromo(code) {
  const value = String(code || '').trim().toUpperCase();
  try { if (value) sessionStorage.setItem(POSTER_PROMO_KEY, value); else sessionStorage.removeItem(POSTER_PROMO_KEY); } catch (e) {}
}
function posterTextFor(p, field) {
  return String((L === 'en' ? p[field + '_en'] : p[field + '_cn']) || (L === 'en' ? p[field + '_cn'] : p[field + '_en']) || '');
}
function posterImageFailed(img) {
  const card = img && img.closest ? img.closest('.poster-card') : null;
  if (img && img.parentElement) img.parentElement.style.display = 'none';
  if (card) card.classList.remove('has-image');
}
function posterCardHtml(p, opening = false) {
  const actionable = p.action_type === 'product' || p.action_type === 'promo';
  const tag = actionable ? 'button' : 'article';
  const title = posterTextFor(p, 'title'), body = posterTextFor(p, 'body');
  const code = p.action_type === 'promo' ? String(p.action_value || '').toUpperCase() : '';
  const claimed = code && pendingPosterPromo() === code;
  const customCta = posterTextFor(p, 'cta');
  const cta = claimed ? (L === 'en' ? '✓ Saved · checked at checkout' : '✓ 已领取，结账时验证')
    : customCta || (p.action_type === 'product' ? (L === 'en' ? 'View product →' : '查看商品 →') : (p.action_type === 'promo' ? (L === 'en' ? 'Save promo →' : '领取优惠 →') : ''));
  return `<${tag}${actionable ? ` type="button" data-poster-action="${esc(p.id)}"` : ''} class="poster-card${p.image_url ? ' has-image' : ''}" data-poster-id="${esc(p.id)}">
    ${p.image_url ? `<span class="poster-image"><img src="${esc(p.image_url)}" alt="" loading="${opening ? 'eager' : 'lazy'}" decoding="async" onerror="posterImageFailed(this)"></span>` : ''}
    <span class="poster-copy"><span class="poster-kicker">${esc(posterKicker())}</span>
      <span class="poster-title" role="heading" aria-level="2"${opening ? ' id="posterDialogTitle"' : ''}>${esc(title)}</span>
      ${body ? `<span class="poster-body">${esc(body)}</span>` : ''}
      ${code ? `<span class="poster-code"><small>${L === 'en' ? 'PROMO' : '优惠码'}</small><strong>${esc(code)}</strong><small>${claimed ? (L === 'en' ? 'SAVED' : '已领取') : (L === 'en' ? 'TAP TO SAVE' : '点击领取')}</small></span>` : (p.badge ? `<span class="poster-code"><strong>${esc(p.badge)}</strong></span>` : '')}
      ${cta ? `<span class="poster-cta">${esc(cta)}</span>` : ''}</span></${tag}>`;
}
function posterKicker() {
  const b = BRAND || {};
  const name = L === 'en' ? (b.name_en || b.name_cn) : (b.name_cn || b.name_en);
  const tail = L === 'en' ? 'ONLINE EXCLUSIVE' : '官网专享';
  return name ? `${name} · ${tail}` : tail;
}
function bindPosterActions(root) {
  (root || document).querySelectorAll('[data-poster-action]').forEach(el => { el.onclick = () => activatePoster(el.dataset.posterAction); });
}
function renderHomepagePosters() {
  const el = document.getElementById('posterRail'); if (!el) return;
  const home = POSTERS.filter(p => p && p.show_on_home);
  // 发布页里的 <section class="offers"> 是给爬虫看的同一批优惠：海报条画出来后就藏起它，首屏不重复
  const crawlerOffers = document.querySelector('body > section.offers'); if (crawlerOffers) crawlerOffers.hidden = home.length > 0;
  if (!home.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `<div class="poster-rail-track" aria-label="${L === 'en' ? 'Offers' : '优惠活动'}">${home.map(p => posterCardHtml(p)).join('')}</div>`;
  bindPosterActions(el);
}
function posterSeenId(p) { return `${p.id}@${p.revision || '1'}`; }
function openingPosterSeen(p) {
  try { return JSON.parse(sessionStorage.getItem(POSTER_SEEN_KEY) || '[]').includes(posterSeenId(p)); } catch (e) { return false; }
}
function markOpeningPosterSeen(p) {
  if (!p) return;
  try { const seen = JSON.parse(sessionStorage.getItem(POSTER_SEEN_KEY) || '[]'); sessionStorage.setItem(POSTER_SEEN_KEY, JSON.stringify([posterSeenId(p), ...seen.filter(x => x !== posterSeenId(p))].slice(0, 24))); } catch (e) {}
}
function maybeShowOpeningPoster() {
  try { if (sessionStorage.getItem(POSTER_SESSION_SHOWN_KEY) === '1') return; } catch (e) {}
  const q = new URLSearchParams(location.search);
  if (['order','topup','token','error'].some(k => q.has(k)) || ['sheet','memberSheet','wxSheet'].some(id => document.getElementById(id)?.classList.contains('show'))) return;
  const p = POSTERS.find(x => x && x.show_on_open && !openingPosterSeen(x)); if (!p) return;
  try { sessionStorage.setItem(POSTER_SESSION_SHOWN_KEY, '1'); } catch (e) {}
  OPEN_POSTER_ID = p.id; renderOpeningPoster();
}
// V03：弹层打开时背景 inert、Tab / Shift+Tab 只在弹层里循环（Escape 关闭见下方）；
// 关闭后撤掉 inert，把焦点还给打开前的元素 —— 首访自动弹出时没有，就落到「开始点餐」，不留在已隐藏的弹层位置（否则下一次 Tab 跳进页脚）。
let POSTER_RETURN_FOCUS = null;
let POSTER_INERT = [];
function setPosterBackgroundInert(on) {
  if (!on) { POSTER_INERT.forEach(el => el.removeAttribute('inert')); POSTER_INERT = []; return; }
  if (POSTER_INERT.length) return;
  const modal = document.getElementById('posterModal');
  POSTER_INERT = Array.from(document.body.children).filter(el => el !== modal && el.id !== 'posterToast' && el.tagName !== 'SCRIPT' && !el.hasAttribute('inert'));
  POSTER_INERT.forEach(el => el.setAttribute('inert', ''));
}
function restorePosterFocus() {
  const back = POSTER_RETURN_FOCUS; POSTER_RETURN_FOCUS = null;
  const target = back && back.isConnected && !back.closest('[inert]') && back.getClientRects().length ? back
    : document.querySelector('.order-start-cta') || document.getElementById('langBtn');
  if (target) target.focus({ preventScroll: true });
}
function renderOpeningPoster() {
  const modal = document.getElementById('posterModal'), dialog = document.getElementById('posterDialog'); if (!modal || !dialog) return;
  const p = POSTERS.find(x => x.id === OPEN_POSTER_ID);
  const wasOpen = modal.classList.contains('show');
  if (!p) {
    modal.classList.remove('show'); modal.setAttribute('aria-hidden','true'); document.body.classList.remove('poster-open'); dialog.innerHTML = '';
    if (wasOpen) { setPosterBackgroundInert(false); restorePosterFocus(); }
    return;
  }
  if (!wasOpen) { const active = document.activeElement; POSTER_RETURN_FOCUS = active && active !== document.body && !modal.contains(active) ? active : null; }
  dialog.innerHTML = `<div class="poster-toolbar"><span>${L === 'en' ? 'ONLINE EXCLUSIVE' : '官网专享'}</span><button type="button" class="poster-close" id="posterClose" aria-label="${L === 'en' ? 'Close offer' : '关闭海报'}">×</button></div>${posterCardHtml(p, true)}`;
  modal.classList.add('show'); modal.setAttribute('aria-hidden','false'); document.body.classList.add('poster-open');
  setPosterBackgroundInert(true);
  document.getElementById('posterClose').onclick = () => closeOpeningPoster(true); bindPosterActions(dialog); document.getElementById('posterClose').focus();
}
document.addEventListener('keydown', e => {
  if (!OPEN_POSTER_ID || e.key !== 'Tab') return;
  const dialog = document.getElementById('posterDialog');
  const items = dialog ? Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length) : [];
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], active = document.activeElement;
  if (e.shiftKey ? (active === first || !items.includes(active)) : (active === last || !items.includes(active))) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
});
function closeOpeningPoster(remember = true) {
  const p = POSTERS.find(x => x.id === OPEN_POSTER_ID); if (remember) markOpeningPosterSeen(p); OPEN_POSTER_ID = ''; renderOpeningPoster();
}
let POSTER_TOAST_TIMER = null;
function showPosterToast(message) {
  const el = document.getElementById('posterToast'); if (!el) return; clearTimeout(POSTER_TOAST_TIMER); el.textContent = message; el.classList.add('show'); POSTER_TOAST_TIMER = setTimeout(() => el.classList.remove('show'), 2600);
}
function focusPosterProduct(sku) {
  const card = Array.from(document.querySelectorAll('[data-product-sku]')).find(el => el.dataset.productSku === String(sku || ''));
  if (!card) return showPosterToast(L === 'en' ? 'This product is temporarily unavailable.' : '这个商品暂时未上架');
  card.scrollIntoView({ behavior:'smooth', block:'center' }); card.classList.remove('poster-focus'); requestAnimationFrame(() => card.classList.add('poster-focus')); setTimeout(() => card.classList.remove('poster-focus'), 1900);
}
function activatePoster(id) {
  if (isPreviewPage()) return;
  const p = POSTERS.find(x => x.id === id); if (!p) return;
  markOpeningPosterSeen(p); closeOpeningPoster(false);
  if (p.action_type === 'promo') {
    setPendingPosterPromo(p.action_value); renderHomepagePosters(); showPosterToast(L === 'en' ? `${p.action_value} saved — checked at checkout.` : `已领取 ${p.action_value}，结账时验证是否可用`);
  } else if (p.action_type === 'product') requestAnimationFrame(() => focusPosterProduct(p.action_value));
}
document.getElementById('posterModal').onclick = e => { if (e.target.id === 'posterModal') closeOpeningPoster(true); };
document.addEventListener('keydown', e => { if (OPEN_POSTER_ID && e.key === 'Escape') closeOpeningPoster(true); });

// V07：分类取自在售商品的实际数据 —— 已知分类按固定顺序，文案表里没有的分类排在后面、用原始键名，
// 绝不因为缺中英文案就把整组商品吞掉。锚点规则与 worker/public-render.js 的 categoryAnchorId 一致。
function menuCategories() {
  const known = CATEGORIES.map(c => c.key);
  const present = [...new Set(PRODUCTS.map(p => String(p.category || 'other')))];
  return [...known.filter(key => present.includes(key)), ...present.filter(key => !known.includes(key))];
}
function categoryAnchorId(category) { return `cat-${String(category).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`; }
function render() {
  const m = document.getElementById('menu');
  // 商品详情 / 自取点 / 优惠这些发布页没有 #menu：服务端已经渲染好内容，
  // 注水阶段不许把它盖掉（购物车、结账、会员照常工作）。
  if (!m) { renderProductDetail(); updateBar(); return; }
  renderOrderStart();
  if (!PRODUCTS.length) { m.innerHTML = `<p class="muted" style="padding:20px">${L==='en'?'Menu is being updated — please check back soon.':'菜单整理中，请稍后再来。'}</p>`; updateBar(); return; }
  const cats = menuCategories(), catLabel = key => { const c = CATEGORIES.find(x => x.key === key); return c ? (L === 'en' ? (c.en || c.cn) : (c.cn || c.en)) : key; };
  let html = `<nav class="cat-nav" aria-label="${L === 'en' ? 'Menu categories' : '菜单分类'}"><div class="cat-nav-track">${cats.map(key => `<a href="#${categoryAnchorId(key)}">${esc(catLabel(key))}</a>`).join('')}</div></nav>`;
  requestAnimationFrame(updateCategoryNav);
  for (const key of cats) {
    const items = PRODUCTS.filter(p => String(p.category || 'other') === key);
    if (!items.length) continue;
    html += `<h2 class="cat" id="${categoryAnchorId(key)}">${esc(catLabel(key))}</h2><div class="grid">`;
    for (const p of items) {
      const q = cart[p.sku]?.qty || 0;
      // 商品页路由是 /menu/<slug>：相对路径会被解析成 /menu/img/01.png 而 404，
      // 所以这里统一绝对化。
      const img = p.img ? publicAssetUrl(p.img) : '/img/product-fallback.svg';
      const desc = pdesc(p);
      const contents = pcontents(p);
      const detail = pdetail(p);
      html += `<div class="card" data-product-sku="${esc(p.sku)}">
        <img src="${esc(img)}" alt="${esc(pname(p))}" loading="lazy" onerror="this.onerror=null;this.src='/img/product-fallback.svg'">
        <div class="body">
          <div class="n">${esc(pname(p))}</div><div class="en">${esc(L === 'en' ? p.name_cn : p.name_en)}</div>
          ${productTagsHtml(p)}
          ${contents ? `<div class="desc contents">${esc(contents)}</div>` : ''}
          ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
          ${p.kcal ? `<div class="nofood">${p.kcal} kcal</div>` : ''}
          ${detail || p.slug ? `<details><summary>${L === 'en' ? 'Details' : '详情'}</summary><div>${esc(detail)}${p.slug ? `<a class="product-detail-link" href="${esc(menuHref())}/${encodeURIComponent(p.slug)}">${L === 'en' ? 'View product →' : '查看商品 →'}</a>` : ''}</div></details>` : ''}
          <div class="row"><span class="p">S$ ${p.price.toFixed(2)}</span>
            <span class="ctl" data-sku="${p.sku}">${ctlHtml(p.sku, q)}</span></div>
        </div></div>`;
    }
    html += `</div>`;
  }
  m.innerHTML = html;
  bind();
  updateBar();
}
// Hydrate the existing article, including already-published HTML, without replacing the page shell or SEO content.
function renderProductDetail() {
  const article = document.querySelector('.product-detail[data-sku]');
  if (!article) return;
  const p = PRODUCTS.find(item => item.sku === article.dataset.sku);
  if (!p) return;
  const en = L === 'en';
  article.querySelector('h1').innerHTML = `${esc(pname(p))} <small>${esc(en ? p.name_cn : p.name_en)}</small>`;
  const img = article.querySelector('img'); if (img) img.alt = pname(p);
  article.querySelector('.price').textContent = `S$ ${p.price.toFixed(2)}`;
  for (const [selector, text] of [['.contents', pcontents(p)], ['.description', pdesc(p)], ['.detail', pdetail(p)]]) {
    const el = article.querySelector(selector); if (el) el.textContent = text;
  }
  article.querySelectorAll('.contents-en, .description-en, .detail-en').forEach(el => el.hidden = true);
  article.querySelectorAll('.tag').forEach((el, i) => {
    const tag = p.tags[i]; if (tag) el.textContent = `${tag.icon || ''} ${(en ? tag.label_en || tag.label_cn : tag.label_cn || tag.label_en) || ''}`.trim();
  });
  let controls = article.querySelector('.ctl');
  if (!controls) {
    const button = article.querySelector('[data-add-sku]');
    if (!button) return;
    controls = document.createElement('span'); controls.className = 'ctl'; controls.dataset.sku = p.sku;
    button.replaceWith(controls);
  }
  controls.innerHTML = ctlHtml(p.sku, cart[p.sku]?.qty || 0, true);
  let back = article.querySelector('.back-to-menu');
  if (!back) { back = document.createElement('a'); back.className = 'back-to-menu'; back.href = menuHref(); article.prepend(back); }
  back.textContent = en ? '← Back to menu' : '← 返回菜单';
  bind();
}
function productTagsHtml(p) {
  const tags = (p.tags || []).map(tag => `<span class="tag tag-${esc(tag.tone)}">${esc(tag.icon)} ${esc((L === 'en' ? tag.label_en || tag.label_cn : tag.label_cn || tag.label_en) || '')}</span>`).join('');
  return tags ? `<div class="product-tags">${tags}</div>` : '';
}
function ctlHtml(sku, q, detail = false) {
  const name = esc(pname(PRODUCTS.find(p => p.sku === sku) || cart[sku]?.p || { name_cn: sku }));
  const incLabel = `${L === 'en' ? 'Add one' : '增加一件'} ${name}`, decLabel = `${L === 'en' ? 'Remove one' : '减少一件'} ${name}`;
  const cannotAdd = q >= 99 || cart[sku]?.unavailable;
  sku = esc(sku);
  return q > 0
    ? `<span class="qty"><button type="button" data-a="dec" data-sku="${sku}" aria-label="${decLabel}">−</button><span aria-live="polite">${q}</span><button type="button" data-a="inc" data-sku="${sku}" aria-label="${incLabel}"${cannotAdd ? ' disabled style="opacity:.35"' : ''}>+</button></span>`
    : `<button type="button" class="add" data-a="inc" data-sku="${sku}" aria-label="${incLabel}"${detail ? ` data-add-sku="${sku}"` : ''}>${detail ? (L === 'en' ? 'Add to cart' : '加入购物车') : '+'}</button>`;
}
function bind() {
  if (isPreviewPage()) { document.querySelectorAll('[data-a]').forEach(el => { el.disabled = true; el.onclick = null; }); return; }
  document.querySelectorAll('[data-a]').forEach(el => el.onclick = () => {
    const sku = el.dataset.sku, p = PRODUCTS.find(x => x.sku === sku);
    if (!p || (el.dataset.a === 'inc' && cart[sku]?.unavailable)) return;
    if (!cart[sku]) cart[sku] = { p, qty: 0 };
    cart[sku].qty = Math.min(99, cart[sku].qty + (el.dataset.a === 'inc' ? 1 : -1));   // 上限 99，与后端一致(防建好车结账才撞 400)
    if (cart[sku].qty <= 0) delete cart[sku];
    const span = el.closest('.ctl'); span.innerHTML = ctlHtml(sku, cart[sku]?.qty || 0, !!span.closest('.product-detail'));
    bind(); updateBar(); saveCart();
  });
}
function totals() {
  let sub = 0, n = 0;
  for (const k in cart) { if (!cart[k].unavailable) sub += cart[k].p.price * cart[k].qty; n += cart[k].qty; }
  return { sub, n };
}
function money(v) { return Math.round((+v || 0) * 100) / 100; }
function chargePreview(sub, fee, disc) {
  const p = CONFIG.pricing || {};
  const goods = Math.max(0, money(sub) - money(disc));
  const svc = p.service_charge_enabled ? money(goods * (+p.service_charge_rate || 0) / 100) : 0;
  const taxable = money(goods + money(fee) + svc);
  const gst = p.gst_registered ? money(taxable * (+p.gst_rate || 0) / 100) : 0;
  return { goods, service_charge: svc, gst, total: money(taxable + gst) };
}
function updateBar() {
  const { sub, n } = totals();
  document.getElementById('total').textContent = 'S$ ' + sub.toFixed(2);
  document.getElementById('count').textContent = n + ' ' + t('items');
  const co = document.getElementById('checkout');
  if (!canOrder()) { co.disabled = true; co.textContent = isPreviewPage() ? (L === 'en' ? 'Preview only' : '仅供预览') : t('closedShort'); }
  else { co.disabled = n === 0; co.textContent = t('checkout'); }
}

document.getElementById('checkout').onclick = () => openCheckout();
document.getElementById('sheet').onclick = e => { if (e.target.id === 'sheet') hide(); };
function hide() { document.getElementById('sheet').classList.remove('show'); }

function cartLinesHtml() {
  const en = L === 'en';
  return Object.values(cart).map(c =>
    `<div class="line" style="align-items:center"><span>${esc(pname(c.p))}${c.unavailable ? `<small class="cart-unavailable">${en ? 'Unavailable — remove to continue' : '已下架，请移除后继续'}</small>` : ''}</span>
       <span class="qty" style="gap:8px"><button type="button" data-ca="dec" data-sku="${esc(c.p.sku)}" aria-label="${en ? 'Remove one' : '减少一件'} ${esc(pname(c.p))}">−</button><span>${c.qty}</span><button type="button" data-ca="inc" data-sku="${esc(c.p.sku)}" aria-label="${en ? 'Add one' : '增加一件'} ${esc(pname(c.p))}"${c.unavailable || c.qty >= 99 ? ' disabled' : ''}>+</button>
       <b style="min-width:64px;text-align:right">${c.unavailable ? '—' : 'S$ ' + (c.p.price*c.qty).toFixed(2)}</b></span></div>`
  ).join('') || `<p class="muted">${en?'Cart is empty':'购物车是空的'}</p>`;
}
function bindCartLines() {
  document.querySelectorAll('#coLines [data-ca]').forEach(b => b.onclick = () => {
    const sku = b.dataset.sku; if (!cart[sku]) return;
    if (b.dataset.ca === 'inc' && cart[sku].unavailable) return;
    cart[sku].qty = Math.min(99, cart[sku].qty + (b.dataset.ca === 'inc' ? 1 : -1));   // 上限 99，与后端一致
    if (cart[sku].qty <= 0) delete cart[sku];
    saveCart(); render();
    if (!Object.keys(cart).length) { hide(); return; }
    document.getElementById('coLines').innerHTML = cartLinesHtml();
    bindCartLines();
    const ck = document.querySelector('[name=ff]:checked')?.value;
    if ((ck === 'discount' || ck === 'anytime') && (document.getElementById('postal')?.value.trim().replace(/\D/g, '').length || 0) >= 6) lookupPostal();   // 数量变 → 重新报价（anytime 的 free_above 门槛依赖 subtotal，否则预览运费停留旧值≠成交价）
    if (PROMO?.code) applyPromo(); else recalcDue();   // 数量变 → 按新 subtotal 重算折扣(尤其百分比码/min_spend)，与后端成交金额一致
  });
}
// ── 唯一的易变公开读取：紧急停业开关 ───────────────────────────────────────
// 只在三个时刻调用：①打开结账 ②结账开着时页面重新可见 ③首次提交订单前。
// 普通浏览、加购物车、看商品/自取点/优惠一律不调用。
let _storeStatusAt = 0;
async function refreshStoreStatus() {
  try {
    const r = await fetch('/api/store-status', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    CONFIG.store_open = d.store_open !== false;
    CONFIG.store_closed_msg = d.message || '';
    _storeStatusAt = Date.now();
    applyStoreState();
    return d;
  } catch (e) { return null; }   // 网络失败不改本地状态：服务端下单时会再独立校验一次
}
window.refreshStoreStatus = refreshStoreStatus;

// 结账开着时页面重新可见 → 重新确认一次（老板可能在这期间紧急停业）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const sheet = document.getElementById('sheet');
  if (sheet && sheet.classList.contains('show')) refreshStoreStatus();
});

function openCheckout() {
  if (isPreviewPage()) return;
  if (!canOrder()) { alert(closedMsgText()); return; }
  refreshStoreStatus();   // ① 打开结账   // 仅紧急下线才拦；营业时段外允许进结账预约（时间由后端 checkFulfilTime 校验）
  const en = L === 'en';
  const carriedPromo = pendingPosterPromo();
  const opts = [];
  const pickups = pickupPoints();
  const pickupOptions = pickups.map(p => `<option value="${esc(p.id || '')}">${esc(pickupPointName(p, en))}${p.postal ? ` · S(${esc(p.postal)})` : ''}</option>`).join('');
  if (pickups.length) opts.push(`<label><input type="radio" name="ff" value="pickup"><span>${en?'Pickup':'自取'}</span></label>`);
  if (CONFIG.delivery.enabled) opts.push(`<label><input type="radio" name="ff" value="discount"><span>${en?'Scheduled':'优惠配送'}</span></label>`);
  opts.push(`<label><input type="radio" name="ff" value="anytime"><span>${en?'Anytime':'自费随时送'}</span></label>`);
  document.getElementById('sheetBody').innerHTML = `
    <h2>${t('confirm')}</h2>
    <p id="menuChanges" class="menu-changes" role="status"${_menuChangesMessage || (_cartRevision && _cartRevision !== window.HL_MENU_REVISION) ? '' : ' hidden'}>${esc(_menuChangesMessage || (en ? 'This saved cart comes from an earlier menu. Prices and availability will be checked before payment; any changes require your confirmation.' : '购物车来自之前的菜单。付款前会核对价格和是否在售，有变化时需要你重新确认。'))}</p>
    <div id="coLines">${cartLinesHtml()}</div>
    <div class="field"><label>${t('fulfil')}</label>
      <div class="seg">${opts.join('')}</div>
      <div class="muted" id="tierHint" style="font-size:11.5px;margin-top:5px"></div></div>
    <div class="field" id="pickupPointField" style="display:none"><label>${en?'Pickup point':'自取点'}</label><select id="pickupPoint">${pickupOptions}</select></div>
    <div id="pickupInfo" class="pickup-card"></div>
    <div class="field" id="postalField" style="display:none"><label>${en?'Delivery postal code':'配送邮编'}</label>
      <div style="display:flex;gap:6px"><input id="postal" inputmode="numeric" maxlength="6" placeholder="${en?'6-digit postal':'6 位邮编'}" style="flex:1">
        <button id="lookupPostal" type="button" style="background:var(--green);color:var(--on-primary,#fff);border:none;border-radius:8px;padding:0 16px;font-weight:700">${en?'Check':'查询'}</button></div>
      <div id="zoneMsg" style="font-size:13px;margin-top:5px;line-height:1.5"></div></div>
    <div class="field" id="addrField" style="display:none"><label>${t('addr')}</label><input id="addr" placeholder="${t('addrPh')}"></div>
    <div class="field" id="dateField"><label id="dateLabel">${en?'Date & time (blank = ASAP)':'日期与时间（留空=尽快）'}</label>
      <div style="display:flex;gap:6px"><input id="date" type="date" style="flex:1"><input id="time" type="time" step="300" style="flex:1"></div>
      <div id="autoScheduleMsg" style="font-size:12px;color:var(--green-text,var(--green));font-weight:700;margin-top:4px"></div>
      <div id="timeHint" style="font-size:12px;color:var(--muted);margin-top:3px"></div>
      <div id="dateMsg" style="font-size:12px;color:var(--red);margin-top:3px"></div></div>
    <div class="field"><label>${t('phone')} <span style="color:var(--muted);font-weight:400">${en?'(optional when signed in)':'（登录用户可不填）'}</span></label><input id="phone" placeholder="+65 9123 4567" inputmode="tel"></div>
    <div class="field"><label>${t('name')} <span style="color:var(--muted);font-weight:400">${en?'(optional)':'(可选)'}</span></label><input id="name" placeholder="${t('namePh')}"></div>
    <div class="field"><label>${t('noteLabel')} <span style="color:var(--muted);font-weight:400">${t('noteHint')}</span></label><input id="note" maxlength="200" placeholder="${t('notePh')}"></div>
    <div id="moreOpts">
      <label style="display:flex;align-items:flex-start;gap:10px;margin:10px 0 14px;padding:12px;border:1px solid var(--gold2);border-radius:12px;background:#FFF9EC;font-size:14px">
        <input type="checkbox" id="useBal" style="width:20px;height:20px;margin-top:1px;flex:0 0 auto">
        <span><b id="useBalLabel" style="display:block;color:var(--green-text,var(--green))">${t('useBalance')}</b><span class="muted" style="display:block;font-size:12px;line-height:1.5;margin-top:3px">${t('balanceAutoHint')}</span></span>
      </label>
      <div class="field"><label>${t('promoLabel')}</label>
        <div style="display:flex;gap:6px"><input id="promo" placeholder="${t('promoPh')}" style="flex:1;text-transform:uppercase">
          <button id="applyPromo" type="button" style="background:var(--green);color:var(--on-primary,#fff);border:none;border-radius:8px;padding:0 16px;font-weight:700">${t('apply')}</button></div>
        <div id="promoMsg" style="font-size:12px;margin-top:4px"></div></div>
    </div>
    <div id="sheetSummary"><!-- 明细由 recalcDue() 重建：小计/优惠/运费/余额抵扣/应付 --></div>
    <button class="primary" id="submit">${t('placeOrder')}</button>
    <p class="muted" style="margin-top:8px">${t('orderNote')}</p>
    <div class="checkout-help"><div class="muted">${en ? 'Need help before ordering?' : '下单前有问题？'}</div>${contactActionsHtml(en)}</div>
    <p class="muted" style="margin-top:4px">${t('agreeTerms')} <a href="/terms" target="_blank" style="color:var(--green-text,var(--green));font-weight:700">${t('termsLink')}</a></p>`;
  document.getElementById('sheet').classList.add('show');
  const first = document.querySelector('[name=ff]'); if (first) first.checked = true;
  bindCartLines();
  document.querySelectorAll('[name=ff]').forEach(r => r.onchange = onFf);
  const pickupSelect = document.getElementById('pickupPoint'); if (pickupSelect) pickupSelect.onchange = () => { renderPickupInfo(); recalcDue(); };
  document.getElementById('applyPromo').onclick = applyPromo;
  // 取消自动抵扣只改变本单的付款选择，已登录会员的真实余额仍应一直显示。
  document.getElementById('useBal').onchange = () => { if (document.getElementById('useBal').checked) refreshBalanceHint(); else recalcDue(); };
  document.getElementById('lookupPostal').onclick = lookupPostal;
  // 邮编失焦即自动查询：配送档填好邮编就立刻算运费/判可否配送，不必等点「查询」——
  // 避免在查询前误显"运费 S$0、可下单"（服务端虽始终拦截，但前端应即时反映真实运费/拦单）。
  document.getElementById('postal').onblur = () => {
    const v = document.querySelector('[name=ff]:checked')?.value;
    if ((v === 'discount' || v === 'anytime') && document.getElementById('postal').value.trim().length >= 6) lookupPostal();
  };
  document.getElementById('postal').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g,''); _lookupReq++; ZONE = null; ANY_FEE = 0; ANY_BLOCKED = false; const m = document.getElementById('zoneMsg'); if (m) m.innerHTML=''; const dm = document.getElementById('dateMsg'); if (dm) dm.textContent=''; const a = document.getElementById('addr'); if (a && _autoAddr && a.value === _autoAddr) { a.value = ''; _autoAddr = ''; }   // 邮编一动，上个邮编自动带出的街道立刻作废
    recalcDue(); };
  document.getElementById('date').onchange = () => { const m=document.getElementById('autoScheduleMsg'); if(m)m.textContent=''; onDateChange(); };
  document.getElementById('time').onchange = () => { const m=document.getElementById('autoScheduleMsg'); if(m)m.textContent=''; onDateChange(); };
  document.getElementById('submit').onclick = submit;
  onFf();
  prefillCheckoutMember().then(() => {
    if (carriedPromo) { const input = document.getElementById('promo'); if (input) input.value = carriedPromo; applyPromo(); }
  });
}
function shopNameText() {
  const b = BRAND || {};
  return (CONFIG.shop && CONFIG.shop.name) || [b.name_cn, b.name_en].filter(Boolean).join(' ');
}
// 英文界面优先用英文版；老板没填就回落中文 —— 宁可显示中文，也不要留白
function shopAddressText() {
  const s = CONFIG.shop || {};
  return (L === 'en' && s.address_en) || s.address || '';
}
function shopDetailText() {
  const s = CONFIG.shop || {};
  return (L === 'en' && s.detail_en) || s.detail || '';
}
function pickupPoints() {
  const pts = CONFIG.shop && Array.isArray(CONFIG.shop.points) ? CONFIG.shop.points.filter(p => p && p.active !== false) : [];
  if (pts.length) return pts;
  if (!CONFIG.pickup_enabled) return [];
  return [{ id:'main', active:true, name:shopNameText(), address:shopAddressText(), detail:shopDetailText(), photo:(CONFIG.shop && CONFIG.shop.photo) || '' }];
}
function pickupPointName(p, en = L === 'en') { return (en ? (p.name_en || p.name) : (p.name || p.name_en)) || shopNameText(); }
// 取餐点说明：老板填了英文就用英文；只有中文时走 V01 的逐句对照表，表里没有的原样显示并标注。
function pickupDetailText(p, en = L === 'en') {
  const own = String((en && p.detail_en) || '').trim();
  return own ? { lines: [own], zhOnly: false } : opsText(p.detail, en);
}
function renderHomepagePickupPoints() {
  if (!isGridPage()) { const host = document.getElementById('pickupHome'); if (host) host.innerHTML = ''; return; }
  const el = document.getElementById('pickupHome'); if (!el) return;
  const en = L === 'en', points = pickupPoints();
  if (!points.length) { el.innerHTML = ''; return; }
  const rows = points.map(p => {
    const address = String((en && p.address_en) || p.address || '').trim();
    const detail = pickupDetailText(p, en);
    const sub = [address, detail.lines.join(' ')].filter(Boolean).join(' · ');
    return `<div class="pickup-home-item"><b>${esc(pickupPointName(p,en))}</b><span>${esc(sub || (en ? 'Pickup details shown at checkout' : '详细取餐信息会在结账时显示'))}</span>${detail.zhOnly ? '<small class="ops-zh-note">Chinese only</small>' : ''}</div>`;
  }).join('');
  el.innerHTML = `<section class="pickup-home"><div class="pickup-home-head"><div><div class="pickup-home-title">${en?'🥡 Choose your pickup point':'🥡 可选取餐点'}</div><div class="pickup-home-hint">${en?'Choose one when checking out; only active locations are shown.':'下单结账时可选择；这里只显示目前开放的取餐点。'}</div></div><span class="pickup-home-count">${points.length} ${en?'locations':'个取餐点'}</span></div><div class="pickup-home-list">${rows}</div></section>`;
}
function selectedPickupPoint() {
  const pts = pickupPoints(), select = document.getElementById('pickupPoint');
  return select ? pts.find(p => p.id === select.value) || null : pts[0] || null;
}
function contactInfo() {
  const c = CONFIG.contact || {};
  const digits = String(c.digits || '').replace(/\D/g, '');
  const display = c.display || (digits ? '+' + digits : '');
  return {
    display,
    tel: c.tel_href || (digits ? `tel:+${digits}` : ''),
    wa: c.whatsapp_href || (digits ? `https://wa.me/${digits}` : ''),
  };
}
function whatsappLink(text) {
  const c = contactInfo();
  if (!c.wa) return '';
  const sep = c.wa.includes('?') ? '&' : '?';
  return c.wa + sep + 'text=' + encodeURIComponent(text || defaultContactMessage());
}
function defaultContactMessage(context) {
  const en = L === 'en', shop = shopNameText();
  if (context === 'pickup') return en ? `Hi, I am asking about pickup${shop ? ' at ' + shop : ''}.` : `你好，我想咨询${shop}自取位置。`;
  return en ? `Hi, I would like to ask about my order${shop ? ' at ' + shop : ''}.` : `你好，我想咨询${shop}订单。`;
}
function contactActionsHtml(en, context) {
  const c = contactInfo();
  if (!c.wa && !c.tel) return '';
  const msg = defaultContactMessage(context);
  return `<div class="contact-actions"><a href="${esc(whatsappLink(msg))}" target="_blank" rel="noopener">${en ? 'WhatsApp us' : 'WhatsApp 发消息'}</a><a href="${esc(c.tel)}">${en ? 'Call ' : '一键拨号 '}${esc(c.display)}</a></div>`;
}
function renderContactSurfaces() {
  const en = L === 'en';
  const c = contactInfo();
  const wa = whatsappLink(defaultContactMessage());
  const fab = document.getElementById('helpFab');
  const fwNode = document.getElementById('footerWa'), ftNode = document.getElementById('footerTel');
  if (!wa) {
    // 店主没填联系电话：不显示任何联系入口，也不留一个指向别人号码的默认值。
    if (fab) fab.style.display = 'none';
    if (fwNode) fwNode.style.display = 'none';
    if (ftNode) ftNode.style.display = 'none';
    return;
  }
  if (fab) {
    // V04：旧物化页里 #helpFab 是 body 下的悬浮按钮，滚动时盖住左列商品；统一搬进底栏。
    // 链接本身保留：只打开 WhatsApp 对话框（带预填问候），不会替顾客发送任何消息。
    const bar = document.querySelector('.bar');
    if (bar && fab.parentElement !== bar) bar.prepend(fab);
    fab.href = wa;
    fab.setAttribute('aria-label', en ? 'WhatsApp us' : 'WhatsApp 联系我们');
    fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9.5L5 21.5V18H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg><span class="help-fab-label">WhatsApp</span>';
    fab.style.display = bar ? '' : 'inline-block';
  }
  const fw = document.getElementById('footerWa');
  if (fw) { fw.href = wa; fw.textContent = `WhatsApp ${c.display}`; }
  const ft = document.getElementById('footerTel');
  if (ft) { ft.href = c.tel; ft.textContent = en ? `Call ${c.display}` : `一键拨号 ${c.display}`; }
}
function renderPickupInfo() {
  const box = document.getElementById('pickupInfo'); if (!box) return;
  const v = document.querySelector('[name=ff]:checked')?.value;
  if (v !== 'pickup') { box.style.display = 'none'; box.innerHTML = ''; return; }
  const en = L === 'en';
  const point = selectedPickupPoint();
  if (!point) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const addr = String((en && point.address_en) || point.address || '').trim();
  const detailText = pickupDetailText(point, en);
  const detail = detailText.lines.join('\n') + (detailText.zhOnly ? '\n(Chinese only)' : '');
  const pm = CONFIG.prep_time_min ?? 20;
  // Never show the main kitchen entrance for a different pickup point. An extra
  // point without its own photo is clearer and safer as text-only directions.
  const photo = point.photo || (point.id === 'main' ? ((CONFIG.shop && CONFIG.shop.photo) || '') : '');
  const map = addr ? ` <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}" target="_blank" rel="noopener">${en ? 'Open map' : '打开地图'}</a>` : '';
  box.style.display = 'block';
  box.innerHTML = `${photo ? `<img src="${esc(photo)}" alt="${en ? 'Pickup entrance' : '取餐口照片'}" loading="lazy" onerror="this.style.display='none'">` : ''}
    <div class="ttl">${en ? 'Pickup address' : '取餐地址'}</div>
    <div><b>${esc(pickupPointName(point, en))}</b></div>
    <div>${addr ? esc(addr) + map : (en ? 'Pickup address is being confirmed. Please check WhatsApp before visiting.' : '取餐地址待确认，请到店前查看 WhatsApp 确认信息。')}</div>
    ${detail ? `<div class="pickup-detail">${esc(detail)}</div>` : ''}
    <div class="muted" style="margin-top:3px">${en ? `Ready in about ${pm} minutes.` : `约 ${pm} 分钟可取。`}</div>
    ${contactActionsHtml(en, 'pickup')}`;
}
function onFf() {
  const en = L === 'en';
  const v = document.querySelector('[name=ff]:checked').value;
  const needAddr = (v === 'discount' || v === 'anytime');
  const pickupField = document.getElementById('pickupPointField');
  if (pickupField) pickupField.style.display = v === 'pickup' ? 'block' : 'none';
  document.getElementById('postalField').style.display = needAddr ? 'block' : 'none';
  document.getElementById('addrField').style.display = needAddr ? 'block' : 'none';
  const dl = document.getElementById('dateLabel'), dm = document.getElementById('dateMsg'), hint = document.getElementById('tierHint'), di = document.getElementById('date'), ti = document.getElementById('time'), am = document.getElementById('autoScheduleMsg');
  dm.textContent = '';
  if (am) am.textContent = '';
  renderPickupInfo();
  if (v === 'pickup') { dl.textContent = en?'Pickup date (blank = ASAP)':'取餐日期（留空=尽快）'; const pm = CONFIG.prep_time_min ?? 20; hint.textContent = en?`Pick up at the shop — free · ready in ~${pm} min.`:`到店自取 · 免运费 · 约 ${pm} 分钟可取。`; if (di) { di.min = sgtNowParts().date; di.value = ''; } if(ti)ti.value=''; }
  else if (v === 'anytime') { dl.textContent = en?'Delivery date (blank = ASAP)':'送达日期（留空=尽快）';
    hint.textContent = (en?'Delivery fee is calculated from your postal code below.':'填邮编后按地址实时计算配送费（见下方运费）。');
    if (di) { di.min = sgtNowParts().date; di.value = ''; } if(ti)ti.value=''; }
  else { dl.textContent = en?'Delivery date (zone days only)':'送达日期（仅可选片区配送日）'; hint.textContent = en?"Owner's own van, scheduled by area — cheapest.":'老板自有配送 · 按片区排班、最划算。'; }
  updateTimeConstraints();
  onDateChange();   // 换取餐方式后日期可能落在休息日/非配送日 —— 重跑一次校验，别让提示和禁用态失同步
  autoScheduleCheckoutIfNeeded();
  if (needAddr && document.getElementById('postal').value.trim()) lookupPostal();
  else { const m = document.getElementById('zoneMsg'); if (m) m.innerHTML=''; }
  if (PROMO?.code) applyPromo(); else recalcDue();   // 换取餐方式 → 重验优惠码(仅限自取码切到配送即报错并撤销折扣)
}
let PROMO = null, BAL = 0, _balReq = 0;
function balanceLabel(msg) { return `${t('useBalance')}（${msg}）`; }
function setBalanceHint(msg) {
  const el = document.getElementById('useBalLabel');
  if (el) el.textContent = msg ? balanceLabel(msg) : t('useBalance');
}
async function prefillCheckoutMember() {
  const tk = authToken();
  const useBal = document.getElementById('useBal');
  if (!tk) {
    if (useBal) useBal.checked = false;
    BAL = 0;
    setBalanceHint(L === 'en' ? 'sign in to show balance' : '登录后显示余额');
    recalcDue();
    return;
  }
  try {
    const r = await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + tk } });
    if (r.status === 401) {
      localStorage.removeItem('hl_token');
      MEMBER_SUMMARY = null;
      renderMemberButton();
      if (useBal) useBal.checked = false;
      BAL = 0;
      setBalanceHint(L === 'en' ? 'sign in to show balance' : '登录后显示余额');
      recalcDue();
      return;
    }
    const d = await r.json();
    const m = d.member || {};
    MEMBER_SUMMARY = m;
    renderMemberButton();
    const phone = document.getElementById('phone');
    const name = document.getElementById('name');
    if (phone && !phone.value && m.phone) phone.value = m.phone;
    if (name && !name.value && m.name) name.value = m.name;
    if (m.phone) localStorage.setItem('hl_phone', m.phone);
    BAL = +(m.balance || 0).toFixed(2);
    if (useBal) useBal.checked = BAL > 0;
    setBalanceHint(`${t('balanceLabel')} S$ ${BAL.toFixed(2)}`);
    recalcDue();
  } catch (e) {
    if (useBal) useBal.checked = false;
    BAL = 0;
    setBalanceHint(L === 'en' ? 'unable to read balance' : '暂时无法读取余额');
    recalcDue();
  }
}
function deliveryFee() {
  const v = document.querySelector('[name=ff]:checked')?.value;
  if (v === 'discount' && ZONE) {
    const sub = totals().sub;
    const eff = Math.max(0, sub - (PROMO?.discount || 0));   // 免运门槛按折扣后金额判（与后端一致）
    if (eff >= (ZONE.free_over || 0)) return 0;              // free_over=0 即始终免运（保留原语义）
    if (ZONE.block_below && sub < ZONE.block_below) return 0;   // 起送门槛仍按折扣前商品额；blocked → 不可提交，显 —
    return ZONE.fee;
  }
  if (v === 'anytime') return +ANY_FEE || 0;                    // courier quote (or manual S$0)
  return 0;
}
function switchToAnytime() { const r = document.querySelector('[name=ff][value=anytime]'); if (r) { r.checked = true; onFf(); } }
function setDateConstraints(zone) {
  const inp = document.getElementById('date'); if (!inp) return;
  inp.min = localDateStr(new Date());
  if (!inp.value || !zone.weekdays.includes(weekdayOfStr(inp.value))) { const nd = nextZoneDate(zone); if (nd) inp.value = localDateStr(nd); }
  onDateChange();
}
function winForDate(dateStr) {   // 选中日期的营业时段 [open,close]，未选=今天；当天休息返回 null
  const bh = CONFIG.business_hours; if (!bh) return null;
  if (!dateStr) return bh.today || null;
  const sched = bh.schedule || {};
  const w = sched[weekdayOfStr(dateStr)];
  return (Array.isArray(w) && w.length === 2) ? w : null;
}
function updateTimeConstraints() {   // 按【选中日期】把 time 选择器 min/max + 提示对齐营业时段（防顾客选到服务端会拒的时间、未来日期显示当天时段的错）
  const en = L === 'en';
  const th = document.getElementById('timeHint'), ti = document.getElementById('time'), di = document.getElementById('date');
  if (!th) return;
  const v = document.querySelector('[name=ff]:checked')?.value, pm = CONFIG.prep_time_min ?? 20;
  const win = winForDate(di && di.value);
  if (ti) { if (win) { ti.min = win[0]; ti.max = win[1]; } else { ti.removeAttribute('min'); ti.removeAttribute('max'); } }
  const hrs = !CONFIG.business_hours?.schedule ? '' : win ? (en ? `　Open ${win[0]}–${win[1]}` : `　营业 ${win[0]}–${win[1]}`)
                  : (en ? '　Closed that day — pick another date' : '　当天休息，请改其他日期');
  th.textContent = (v === 'pickup' ? (en ? `Blank = ASAP (~${pm} min).` : `留空=尽快（约 ${pm} 分钟可取）。`) : (en ? 'Blank = ASAP.' : '留空=尽快。')) + hrs;
}
// 选中日期落在本店休息日（business_hours.schedule 里该 weekday 为 null）→ 后端必拒，前端先拦。
function closedWeekday(dateStr) { return !!(CONFIG.business_hours?.schedule && dateStr && !winForDate(dateStr)); }
function onDateChange() {
  updateTimeConstraints();
  const en = L === 'en'; const msg = document.getElementById('dateMsg'); if (!msg) return;
  const v = document.querySelector('[name=ff]:checked')?.value, inp = document.getElementById('date');
  if (inp && inp.value && closedWeekday(inp.value)) {   // 休息日：红字说清楚 + recalcDue 里禁用下单，不再让顾客填完一整单才被后端拒
    msg.textContent = en ? 'We are closed that day — please pick another date.' : '当天本店休息，请改选其他日期。';
    recalcDue(); return;
  }
  if (v !== 'discount' || !ZONE || !inp || !inp.value) { msg.textContent = ''; recalcDue(); return; }
  const days = ZONE.weekdays.map(d => WDAYS(en)[d]).join('/');
  msg.textContent = ZONE.weekdays.includes(weekdayOfStr(inp.value)) ? '' : (en ? `This zone only delivers on ${days}.` : `该片区仅 ${days} 配送，请重选日期。`);
  recalcDue();   // 改日期后重算提交可用态(含非配送日拦截)
}
let _lookupReq = 0;
async function lookupPostal() {
  const en = L === 'en';
  const myReq = ++_lookupReq;   // 序列令牌：快速改邮编时丢弃过期 onemap/quote 响应，防 fee/zone 绑到旧地址（成交金额仍由后端重算，无资金风险）
  const postal = document.getElementById('postal').value.trim();
  const msg = document.getElementById('zoneMsg');
  const tier = document.querySelector('[name=ff]:checked').value;
  if (postal.replace(/\D/g, '').length < 6) { msg.style.color = 'var(--red)'; msg.textContent = en ? 'Enter a 6-digit postal code' : '请输入 6 位邮编'; return; }
  msg.style.color = 'var(--muted)'; msg.textContent = '…';
  let road = '';
  try { const d = await (await fetch('/api/onemap?postal=' + encodeURIComponent(postal))).json(); if (d.found) road = ((d.block ? d.block + ' ' : '') + (d.road || '')).trim(); } catch (e) {}
  if (myReq !== _lookupReq) return;   // 邮编已变，丢弃过期 onemap 响应
  // 只覆盖「空」或「上次自动带出的那条路」——顾客手打的地址永远不动；
  // 查不到路名(road='')时同样要清掉旧的自动值，否则新邮编会配着上一个邮编的街道提交。
  { const a = document.getElementById('addr');
    if (a && (!a.value.trim() || a.value === _autoAddr)) { a.value = road; _autoAddr = road; } }
  if (tier === 'anytime') {
    let q = { mode: 'unavailable', fee: 0, blocked: true };
    try { q = await (await fetch('/api/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ postal, subtotal: totals().sub }) })).json(); } catch (e) {}
    if (myReq !== _lookupReq) return;   // 邮编已变，丢弃过期 quote 响应
    ANY_BLOCKED = !!q.blocked || q.mode === 'unavailable';
    ANY_FEE = ANY_BLOCKED ? 0 : (+q.fee || 0); ZONE = null;
    if (ANY_BLOCKED) {
      msg.style.color = 'var(--red,#A23B2D)';
      msg.innerHTML = (road ? '✓ ' + esc(road) + '<br>' : '') + '⚠ ' + (en ? 'Delivery fee unavailable for this address — please choose Pickup or try later.' : esc(q.note || '该地址暂时无法计算配送运费，请改自取或稍后再试。'));
    } else {
      msg.style.color = 'var(--green)';
      msg.innerHTML = (road ? '✓ ' + esc(road) + '<br>' : '') + (en ? `Delivery fee: S$${ANY_FEE.toFixed(2)}` : `${esc(q.note || '运费')}：S$${ANY_FEE.toFixed(2)}`);
    }
    recalcDue(); return;
  }
  const zone = zoneBySector(postal); ZONE = zone;
  if (!zone) {
    msg.style.color = 'var(--red)';
    msg.innerHTML = (en ? 'Not in a discounted-delivery zone. ' : '该邮编不在优惠配送范围。') +
      `<a id="toAnytime" style="color:var(--green-text,var(--green));font-weight:700;cursor:pointer">${en ? 'Use Anytime →' : '改用自费随时送 →'}</a>`;
    const a = document.getElementById('toAnytime'); if (a) a.onclick = switchToAnytime; recalcDue(); return;
  }
  const days = zone.weekdays.map(d => WDAYS(en)[d]).join('/');
  const sub = totals().sub, blocked = zone.block_below && sub < zone.block_below;
  // 区域提示只描述"免运规则"(满X免运)，不显当前运费 —— 实际运费由下方应付明细权威显示(随促销折扣实时更新)，避免提示「免运费」与明细「运费$8」冲突。
  const feeTxt = blocked
    ? (en ? `min order S$${zone.block_below}` : `未满 S$${zone.block_below} 不可配送`)
    : (zone.free_over > 0 ? (en ? `free delivery over S$${zone.free_over}` : `满 S$${zone.free_over} 免运`) : (en ? 'free delivery' : '免运费'));
  msg.style.color = blocked ? 'var(--red)' : 'var(--green)';
  msg.innerHTML = (road ? '✓ ' + esc(road) + '<br>' : '') + `${en ? (zone.name_en || zone.name_cn) : zone.name_cn} · ${en ? 'delivers ' : '配送日 '}${days} · ${feeTxt}` +
    (blocked ? `<br><a id="toAnytime" style="color:var(--green-text,var(--green));font-weight:700;cursor:pointer">${en ? 'Use Anytime →' : '改用自费随时送 →'}</a>` : '');
  if (blocked) { const a = document.getElementById('toAnytime'); if (a) a.onclick = switchToAnytime; }
  setDateConstraints(zone);
  recalcDue();
}
let _promoReq = 0;
async function applyPromo() {
  const code = document.getElementById('promo').value.trim().toUpperCase();
  const msg = document.getElementById('promoMsg');
  if (!code) { PROMO = null; msg.textContent = ''; recalcDue(); return; }
  const myReq = ++_promoReq;
  const ff = document.querySelector('[name=ff]:checked')?.value;   // 带上取餐方式 → 仅限自取码在配送档即时报错
  const _pTok = localStorage.getItem('hl_token') || '';   // 带会员 token → 预览即可判定 需登录/首单（成交侧再权威验）
  // 先给一个「在查了」的反馈：网络慢的时候按钮不能看起来像坏的
  msg.style.color = 'var(--muted)'; msg.textContent = L === 'en' ? 'Checking…' : '检查中…';
  let r;
  try {
    r = await (await fetch('/api/promo/check', { method:'POST', headers: Object.assign({'content-type':'application/json'}, _pTok ? { authorization: 'Bearer ' + _pTok } : {}), body: JSON.stringify({ code, subtotal: totals().sub, fulfilment: ff, phone: document.getElementById('phone')?.value || '' }) })).json();
  } catch (e) {
    // 原来这里没有 try/catch：请求一抖（断网 / 5xx / 返回的不是 JSON），promise 直接 reject，
    // promoMsg 永远停在空白 —— 顾客点了「应用」屏幕上一点反应都没有，不知道是没优惠还是在转圈。
    if (myReq !== _promoReq) return;
    PROMO = null; msg.style.color = 'var(--red)';
    msg.textContent = L === 'en' ? 'Could not check this code — please try again.' : '优惠码没查成，请重试';
    recalcDue(); return;
  }
  if (myReq !== _promoReq) return;   // 快速连点改数量时丢弃过期响应，防折扣预览停留旧值（成交金额仍由后端重算，无资金风险）
  if (!r || typeof r !== 'object') { PROMO = null; msg.style.color = 'var(--red)'; msg.textContent = L === 'en' ? 'Could not check this code — please try again.' : '优惠码没查成，请重试'; recalcDue(); return; }
  if (r.error) { PROMO = null; msg.style.color = 'var(--red)'; msg.textContent = r.error; }
  else { PROMO = { code, discount: r.discount }; msg.style.color = 'var(--green)'; msg.textContent = `${t('discountLine')} −S$ ${r.discount.toFixed(2)}`; }
  recalcDue();
}
async function refreshBalanceHint() {
  const label = document.getElementById('useBalLabel');
  if (!label) return 0;
  const useBal = document.getElementById('useBal');
  const myReq = ++_balReq;
  // 储值余额只认已登录账号的稳定 user_id，与联系手机号无关。
  const tk = authToken();
  if (!tk) { if (useBal) useBal.checked = false; BAL = 0; setBalanceHint(L === 'en' ? 'sign in to show balance' : '登录后显示余额'); recalcDue(); return 0; }
  setBalanceHint(L === 'en' ? 'checking...' : '查询中...');
  try {
    const r = await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + tk } });
    if (myReq !== _balReq) return BAL;
    if (r.status === 401) { localStorage.removeItem('hl_token'); MEMBER_SUMMARY = null; renderMemberButton(); if (useBal) useBal.checked = false; BAL = 0; setBalanceHint(L === 'en' ? 'sign in to show balance' : '登录后显示余额'); recalcDue(); return 0; }
    const d = await r.json();
    if (!d.member) throw new Error('account not found');
    MEMBER_SUMMARY = d.member;
    renderMemberButton();
    BAL = +(d.member.balance || 0).toFixed(2);
    setBalanceHint(`${t('balanceLabel')} S$ ${BAL.toFixed(2)}`);
    recalcDue();
    return BAL;
  } catch (e) {
    if (myReq !== _balReq) return BAL;
    if (useBal) useBal.checked = false;
    BAL = 0;
    setBalanceHint(L === 'en' ? 'unable to read balance' : '暂时无法读取余额');
    recalcDue();
    return 0;
  }
}
function recalcDue() {
  const sub = totals().sub, disc = PROMO?.discount || 0, fee = deliveryFee();
  const v = document.querySelector('[name=ff]:checked')?.value;
  // 拦单态：优惠配送未满起送额，或 自费随时送 没有有效快递报价——运费/应付显"—"、禁用下单。
  // anytime 必须有 ANY_FEE>0；填了邮编但还没查到费(改邮编后/查询失败/未查询)→ 也拦，强制先查询，避免按 S$0 误导成交。
  const postalLen = (document.getElementById('postal')?.value || '').replace(/\D/g, '').length;
  const blocked = (v === 'discount' && ZONE && ZONE.block_below && sub < ZONE.block_below) || (v === 'discount' && !ZONE) || (v === 'anytime' && (ANY_BLOCKED || (postalLen >= 6 && ANY_FEE <= 0)));   // discount 永远需要已解析片区(submit 也拒 !ZONE)：未填/不在片区(ZONE=null)一律拦——禁用下单 + 运费/应付显"—"，不再显误导的 S$0/应付。片区解析成功后 lookupPostal→recalcDue 即放开
  const ch = chargePreview(sub, fee, disc);
  const balanceCap = Math.min(ch.total, chargePreview(sub, 0, disc).total);   // 储值余额不可抵扣配送费/Lalamove 费用；GST 开启时配送费对应 GST 也保留在 due now。
  const usedBal = (document.getElementById('useBal')?.checked) ? Math.min(BAL, balanceCap) : 0;
  const due = Math.max(0, ch.total - usedBal);
  // 逐项明细，预览必须=后端实收。后端会重算 service/GST 后再扣储值。
  const en = L === 'en';
  const rows = [`<div class="line"><span>${en ? 'Subtotal' : '小计'}</span><span>S$ ${sub.toFixed(2)}</span></div>`];
  if (disc > 0) rows.push(`<div class="line"><span>${t('discountLine')}</span><span style="color:var(--green-text,var(--green))">−S$ ${disc.toFixed(2)}</span></div>`);
  if (v !== 'pickup') rows.push(`<div class="line"><span>${en ? 'Delivery fee' : '运费'}</span><span>${blocked ? '—' : 'S$ ' + fee.toFixed(2)}</span></div>`);
  if (ch.service_charge > 0 && !blocked) rows.push(`<div class="line"><span>${en ? 'Service charge' : '服务费'} ${(+CONFIG.pricing.service_charge_rate || 0).toFixed(1)}%</span><span>S$ ${ch.service_charge.toFixed(2)}</span></div>`);
  if (ch.gst > 0 && !blocked) rows.push(`<div class="line"><span>GST ${(+CONFIG.pricing.gst_rate || 0).toFixed(1)}%</span><span>S$ ${ch.gst.toFixed(2)}</span></div>`);
  if (usedBal > 0 && !blocked) rows.push(`<div class="line"><span>${t('balancePay')}${v !== 'pickup' ? (en ? ' (excl. delivery)' : '（不含运费）') : ''}</span><span style="color:var(--green-text,var(--green))">−S$ ${usedBal.toFixed(2)}</span></div>`);
  rows.push(`<div class="line" style="font-weight:700;border-top:1px solid var(--gold2);padding-top:8px;margin-top:4px"><span>${t('dueNow')}</span><span>${blocked ? '—' : 'S$ ' + due.toFixed(2)}</span></div>`);
  const sumEl = document.getElementById('sheetSummary'); if (sumEl) sumEl.innerHTML = rows.join('');
  // 优惠配送选了非配送日 → 禁止提交（后端也会拒「仅在指定星期配送」，前端先拦免白填一单）。价格仍显，由 dateMsg 提示原因。
  const dv = document.getElementById('date')?.value;
  const zoneDateBad = v === 'discount' && ZONE && dv && !ZONE.weekdays.includes(weekdayOfStr(dv));
  const btn = document.getElementById('submit');
  if (btn) {
    const fulfilment = document.querySelector('[name=ff]:checked');
    btn.disabled = _submitBusy || !canOrder() || blocked || !fulfilment || fulfilment.disabled || (v === 'pickup' && !selectedPickupPoint()) || zoneDateBad || closedWeekday(dv) || totals().n === 0 || Object.values(cart).some(c => c.unavailable);
    if (!_submitBusy && acceptedRevisionForCart()) { btn.textContent = en ? 'Confirm new prices and continue' : '确认新价格并继续'; btn.classList.add('reconfirm'); }
  }
}

// 409 menu_changed 的处理：只改受影响的行，下架行标记不可售，显示旧价 → 新价。
function applyMenuChanges(payload) {
  const changes = payload.changes || [];
  const lines = payload.lines || [];
  for (const line of lines) {
    const entry = cart[line.sku];
    if (!entry) continue;
    const product = PRODUCTS.find(p => p.sku === line.sku);
    for (const key of ['name_cn', 'name_en']) if (typeof line[key] === 'string' && (line.available || line[key])) {
      entry.p[key] = line[key];
      if (product) product[key] = line[key];
    }
    // 组成随新菜单更新：卡片和购物车显示的「含：…」= 厨房将要做的
    if (line.available && Array.isArray(line.components)) for (const key of ['contents_cn', 'contents_en']) {
      entry.p[key] = line[key] || '';
      if (product) product[key] = line[key] || '';
    }
    if (line.available && line.unit_price_cents != null) {
      entry.p.price = line.unit_price_cents / 100;
      entry.p.price_cents = line.unit_price_cents;
      entry.unavailable = false;
      if (product) { product.price = entry.p.price; product.price_cents = entry.p.price_cents; }
    } else {
      entry.unavailable = true;
    }
  }
  // The same response carries the active release's tax/delivery/time rules; never leave the checkout summary on the previous rules.
  const rules = payload.release_rules;
  if (rules) {
    CONFIG.pricing = { gst_registered: rules.gst_registered, gst_rate: rules.gst_rate, service_charge_enabled: rules.service_charge_enabled, service_charge_rate: rules.service_charge_rate };
    CONFIG.delivery = { ...CONFIG.delivery, enabled: rules.delivery_enabled, fee: rules.delivery_fee, min: rules.delivery_min, free_above: rules.delivery_free_above };
    CONFIG.business_hours = businessHoursNow(rules.business_hours_schedule);
    CONFIG.prep_time_min = rules.prep_time_min;
    DCFG = rules.delivery;
    if (Array.isArray(rules.pickup_display)) {
      const points = rules.pickup_display;
      const main = points.find(point => point.id === 'main');
      CONFIG.pickup_enabled = points.length > 0;
      CONFIG.shop = { ...CONFIG.shop, points, name: main?.name || '', address: main?.address || '', detail: main?.detail || '', photo: main?.photo || '' };
      const select = document.getElementById('pickupPoint'), previousId = select.value;
      select.innerHTML = `<option value="">${L === 'en' ? 'Choose a pickup point' : '请选择自取点'}</option>` + points.map(point => `<option value="${esc(point.id)}">${esc(pickupPointName(point))}${point.postal ? ` · S(${esc(point.postal)})` : ''}</option>`).join('');
      select.value = points.some(point => point.id === previousId) ? previousId : '';
    }
    // Keep the customer's form values. A disabled or removed choice must be reviewed explicitly, never silently replaced.
    for (const [value, label, enabled] of [['pickup', L === 'en' ? 'Pickup' : '自取', CONFIG.pickup_enabled], ['discount', L === 'en' ? 'Scheduled' : '优惠配送', CONFIG.delivery.enabled && !!DCFG?.zones?.length]]) {
      let input = document.querySelector(`[name=ff][value="${value}"]`);
      if (!input && enabled) {
        const option = document.createElement('label'); option.innerHTML = `<input type="radio" name="ff" value="${value}"><span>${label}</span>`;
        document.querySelector('#sheetBody .seg').prepend(option); input = option.querySelector('input'); input.onchange = onFf;
      }
      if (input) { input.disabled = !enabled; input.nextElementSibling.textContent = label + (enabled ? '' : (L === 'en' ? ' (unavailable)' : '（暂不可用）')); }
    }
    renderPickupInfo();
    if (document.querySelector('[name=ff]:checked')?.value === 'pickup') document.getElementById('tierHint').textContent = L === 'en' ? `Review your pickup point — ready in ~${CONFIG.prep_time_min} min.` : `请核对自取点，约 ${CONFIG.prep_time_min} 分钟可取。`;
    ZONE = null; ANY_FEE = 0; ANY_BLOCKED = false;
    ++_lookupReq; // Ignore quotes started before this release changed the delivery rules.
    const fulfilment = document.querySelector('[name=ff]:checked')?.value;
    if (fulfilment !== 'pickup') document.getElementById('zoneMsg').textContent = L === 'en' ? 'Menu updated. Check your postal code again to refresh delivery availability and fees.' : '菜单已更新，请重新查询邮编，核对配送是否可用及运费。';
    updateTimeConstraints(); onDateChange();
  }
  // A previous promotion quote depended on the old subtotal. Ask for a fresh explicit quote instead of showing a stale discount.
  ++_promoReq; // Pending checks were priced against the old release too; ignore their late responses.
  PROMO = null;
  const promoMsg = document.getElementById('promoMsg');
  promoMsg.style.color = 'var(--muted)';
  promoMsg.textContent = document.getElementById('promo').value.trim() ? (L === 'en' ? 'Menu updated. Apply the promo code again.' : '菜单已更新，请重新验证优惠码。') : '';
  saveCart();
  render();
  document.getElementById('coLines').innerHTML = cartLinesHtml();
  bindCartLines();
  recalcDue();
  const en = L === 'en';
  const text = changes.map(change => {
    const line = lines.find(l => l.sku === change.sku) || {};
    const name = (en ? line.name_en || line.name_cn : line.name_cn || line.name_en) || change.sku;
    if (change.reason === 'name') {
      const oldName = (en ? change.old_name_en || change.old_name_cn : change.old_name_cn || change.old_name_en) || change.sku;
      const newName = (en ? change.new_name_en || change.new_name_cn : change.new_name_cn || change.new_name_en) || name;
      return `${oldName} \u2192 ${newName}`;
    }
    if (change.reason === 'contents') {
      const next = en ? change.new_contents_en || change.new_contents_cn : change.new_contents_cn || change.new_contents_en;
      return `${name}: ${en ? 'now includes' : '组成改为'} ${next || (en ? '(none)' : '（无）')}`;
    }
    if (change.reason === 'unavailable') return `${name}: ${en ? 'sold out / delisted' : '已售罄或下架'}`;
    const oldPrice = change.old_price_cents == null ? '\u2014' : `S$${(change.old_price_cents / 100).toFixed(2)}`;
    return `${name}: ${oldPrice} \u2192 S$${(change.new_price_cents / 100).toFixed(2)}`;
  }).join('\n');
  _menuChangesMessage = (en ? 'The menu was updated while you were checking out:\n\n' : '结账期间菜单已更新：\n\n')
    + text + (en ? '\n\nPlease review the updated totals, pickup or delivery option and scheduled time, then confirm again.' : '\n\n请核对更新后的总价、自取/配送选项和预约时间，再确认继续。');
  const notice = document.getElementById('menuChanges'); notice.textContent = _menuChangesMessage; notice.hidden = false;
  alert(_menuChangesMessage);
}

async function submit() {
  if (_submitBusy) return;
  _submitBusy = true;
  try { await submitOrder(); }
  finally { _submitBusy = false; recalcDue(); }
}
async function submitOrder() {
  if (isPreviewPage()) return;
  if (Object.values(cart).some(c => c.unavailable)) return;
  const en = L === 'en';
  const fulfilment = document.querySelector('[name=ff]:checked');
  if (!fulfilment || fulfilment.disabled) return;
  const ff = fulfilment.value;
  autoScheduleCheckoutIfNeeded();   // 营业外仍留空时，提交前再次兜底到下一营业时间
  const pickupPoint = ff === 'pickup' ? selectedPickupPoint() : null;
  if (ff === 'pickup' && !pickupPoint) { alert(en ? 'Please select an available pickup point.' : '请选择仍在开放的自取点'); return; }
  if (ff === 'discount' || ff === 'anytime') {
    const pc = document.getElementById('postal').value.trim();
    if (pc.replace(/\D/g, '').length < 6) { alert(en ? 'Enter the delivery postal code' : '请填写配送邮编'); return; }
    const ad = (document.getElementById('addr')?.value || '').trim();   // 配送必须有街道地址(邮编自动填的路名已满足；防 OneMap 没填/被清空 → 司机找不到人)
    if (!ad) { alert(en ? 'Please enter the delivery address (Blk / Street / Unit)' : '请填写配送地址（Blk / 街道 / 单元）'); return; }
    if (ff === 'discount') {
      if (!ZONE) { alert(en ? 'Address not in a discounted zone — use Anytime delivery.' : '该地址不在优惠配送范围，请改用自费随时送。'); return; }
      const sub = totals().sub;
      if (ZONE.block_below && sub < ZONE.block_below) { alert(en ? `Minimum S$${ZONE.block_below} for this zone — use Anytime delivery.` : `该片区需满 S$${ZONE.block_below}，请改用自费随时送。`); return; }
      const dv = document.getElementById('date').value;
      if (!dv) { alert(en ? 'Please choose a delivery date' : '请选择配送日期'); return; }
      if (!ZONE.weekdays.includes(weekdayOfStr(dv))) { alert(en ? 'Selected date is not a delivery day for this zone.' : '所选日期不是该片区的配送日，请重选。'); return; }
    }
    if (ff === 'anytime' && ANY_BLOCKED) { alert(en ? 'Delivery fee unavailable for this address — please choose Pickup or try later.' : '该地址暂时无法计算配送运费，请改为自取或稍后再试。'); return; }
  }
  const btn = document.getElementById('submit'); btn.disabled = true; btn.textContent = t('submitting');
  const postal = document.getElementById('postal')?.value.trim() || null;
  let address = null;
  if (ff !== 'pickup') { const addr = (document.getElementById('addr')?.value || '').trim(); address = ((postal ? 'S' + postal + ' ' : '') + addr).trim() || null; }
  const payload = {
    customer_name: document.getElementById('name').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    fulfilment: ff,
    postal: ff === 'pickup' ? null : postal,
    address,
    pickup_point_id: pickupPoint ? pickupPoint.id : null,
    deliver_at: document.getElementById('date').value || null,
    deliver_time: document.getElementById('time')?.value || null,
    quoted_fee: ff === 'anytime' ? ANY_FEE : (ff === 'discount' && ZONE ? ZONE.fee : null),   // discount 发片区基础费 → 后端校验老板有无中途改费(TOCTOU)
    promo_code: PROMO?.code || null,
    use_balance: document.getElementById('useBal')?.checked || false,
    note: (document.getElementById('note')?.value || '').trim() || null,
    items: Object.values(cart).map(c => ({ sku: c.p.sku, qty: c.qty })),
    // 购物车是哪个发布加出来的：服务端据此判断菜单是否已变。
    menu_revision: acceptedRevisionForCart() || _cartRevision || window.HL_MENU_REVISION,
    client_token: (_orderTok || (_orderTok = crypto.randomUUID())),
  };
  const tk = localStorage.getItem('hl_token');
  const phoneDigits = payload.phone.replace(/\D/g, '');
  if ((!tk && !phoneDigits) || (phoneDigits && (phoneDigits.length < 8 || phoneDigits.length > 15))) { alert(en ? 'Guests need a valid contact phone; signed-in users may leave it blank.' : '游客请填写有效联系电话；已登录用户可不填。'); btn.disabled = false; btn.textContent = t('placeOrder'); return; }
  const h = { 'content-type': 'application/json' };
  if (tk) h.authorization = 'Bearer ' + tk;
  // ③ 首次提交前确认一次。重试沿用同一个 client_token：那时【不再】预检，
  //    直接 POST，让服务端的既有订单去重先跑，避免"其实已下单成功"被后来的
  //    停业或新发布挡在门外。
  if (!_orderAttempted) {
    _orderAttempted = true;
    await refreshStoreStatus();
    if (!canOrder()) { alert(closedMsgText()); btn.disabled = false; btn.textContent = t('placeOrder'); return; }
  }
  if (payload.use_balance) {
    const bal = await refreshBalanceHint();
    if (!tk) { alert(en ? 'Please log in as a member before using stored value.' : '使用储值余额前请先登录会员账户'); btn.disabled = false; btn.textContent = t('placeOrder'); return; }
    if (!(bal > 0)) { alert(en ? 'No stored-value balance is available for this member.' : '当前会员没有可用储值余额'); btn.disabled = false; btn.textContent = t('placeOrder'); return; }
  }
  try {
    const r = await fetch('/api/order', { method: 'POST', headers: h, body: JSON.stringify(payload) });
    const d = await r.json();
    // 菜单在顾客结账期间变了：把差异摆出来，等顾客【再点一次】确认新价格。
    // 绝不自动重提 —— 那等于替顾客同意了他没看过的价格。
    if (r.status === 409 && d.code === 'menu_changed') {
      _acceptedRevision = d.active_revision;
      _acceptedSkus = new Set((d.lines || []).map(line => line.sku));
      applyMenuChanges(d);
      btn.textContent = L === 'en' ? 'Confirm new prices and continue' : '确认新价格并继续';
      btn.classList.add('reconfirm');
      return;
    }
    if (!d.ok) throw new Error(d.error || 'failed');
    if (payload.promo_code && payload.promo_code === pendingPosterPromo()) setPendingPosterPromo('');
    rememberOrder(d.id);   // 记住这一单 → 顾客回首页(或从发票页深链 /?order=)就能看制作进度
    // 单已经建在服务端了，购物车就必须在这里清掉。
    // 清空原本只写在 showPay() 里，而所有下单都带 invoice_url → 上面就 return 了，showPay 根本轮不到，
    // 于是顾客付完钱回首页看见购物车还满着、还亮着「去结算」——很容易再下一单、储值被扣第二次。
    clearCart();
    if (d.checkout_url) { window.location.href = d.checkout_url; return; }  // Stripe PayNow
    if (d.invoice_url) { window.location.href = d.invoice_url; return; }    // PayNow QR invoice page
    showPay(d);
  } catch (e) { alert(t('orderFail') + e.message); btn.disabled = false; btn.textContent = t('placeOrder'); }
}

function showPay(d) {
  // Phase 1: show manual PayNow instructions + reference + invoice link.
  // Phase 2: d will include a HitPay payment URL/QR to embed instead.
  document.getElementById('sheetBody').innerHTML = `
    <div class="pay-result">
      <h2>${t('payTitle')}</h2>
      <p style="margin:8px 0">${t('payNo')} <b>${esc(d.invoice_no)}</b><br>${t('payAmt')} <b style="font-size:20px">S$ ${(d.due_now != null ? d.due_now : d.total).toFixed(2)}</b></p>
      <p class="muted">${t('payTo')}<br><b style="font-size:16px;color:var(--ink)">${esc(d.paynow_uen || '—')}</b></p>
      <p style="margin:10px 0">${t('payRefTip')}<br><span class="ref">${esc(d.pay_ref)}</span></p>
      <a class="primary" style="display:block;text-decoration:none;text-align:center" href="${esc(d.invoice_url || '')}" target="_blank">${t('viewInvoice')}</a>
      <p class="muted" style="margin-top:10px">${t('payAuto')}</p>
      ${contactActionsHtml(L === 'en')}
    </div>`;
  clearCart();
  if (validOrderId(d.id)) { rememberOrder(d.id); PROG.id = d.id; PROG.done = false; PROG.data = null; PROG.note = ''; fetchProgress().then(() => progStartPolling()); }
}

// ---- 顾客侧：订单制作进度卡 ----
// 数据来自 GET /api/order/:id/status（后端字段白名单，订单 UUID 本身就是凭据，卡上不显示姓名/电话/金额）。
// 轮询 15s；页面切到后台立刻停（visibilitychange），回前台补一次再续；status 到 ready/done 就永久停轮询——
// 老顾客的旧单不该一直打接口。
const ORDER_ID_RE = /^[0-9a-fA-F-]{8,64}$/;   // UUID 形态；深链/localStorage 来的 id 一律先过这道校验
const PROG_POLL_MS = 15000;
const _deepOrderId = (() => { try { return new URLSearchParams(location.search).get('order') || ''; } catch (e) { return ''; } })();
let PROG = { id: null, data: null, timer: null, done: false, busy: false, note: '' };
function validOrderId(v) { return typeof v === 'string' && ORDER_ID_RE.test(v); }
function rememberOrder(id) { if (!validOrderId(id)) return; try { localStorage.setItem('hl_last_order', id); } catch (e) {} }
function forgetOrder() { try { localStorage.removeItem('hl_last_order'); } catch (e) {} }
function lastOrderId() { try { const v = localStorage.getItem('hl_last_order'); return validOrderId(v) ? v : null; } catch (e) { return null; } }
function progStopPolling() { if (PROG.timer) { clearInterval(PROG.timer); PROG.timer = null; } }
function progStartPolling() {
  progStopPolling();
  if (!PROG.id || PROG.done || document.hidden) return;
  PROG.timer = setInterval(() => fetchProgress(), PROG_POLL_MS);
}
function progHide(forget) {
  progStopPolling();
  PROG = { id: null, data: null, timer: null, done: true, busy: false, note: '' };
  if (forget) forgetOrder();
  const el = document.getElementById('orderProgress'); if (el) el.innerHTML = '';
}
async function fetchProgress() {
  const id = PROG.id; if (!id) return;
  try {
    const r = await fetch('/api/order/' + encodeURIComponent(id) + '/status');
    if (PROG.id !== id) return;                              // 期间换了单：过期响应一律丢弃，
                                                             // 必须在 404 分支之前判，否则旧单的 404 会把新单的 id 一起清掉
    if (r.status === 404) { progHide(true); return; }        // 单没了(或 id 是脏数据) → 收起并忘掉
    const d = await r.json();
    if (PROG.id !== id) return;                              // await json 期间也可能换单
    if (!d || d.error) return;                               // 临时错误：保留上一次展示，不清卡
    // 12 小时前就已完成的旧单不必长期占屏
    if (d.status === 'done' && d.created_at && (Date.now() - new Date(d.created_at).getTime()) > 12 * 3600 * 1000) { progHide(true); return; }
    PROG.data = d;
    if (d.arrived) PROG.note = '';
    if (d.status === 'ready' || d.status === 'done') { PROG.done = true; progStopPolling(); }
    renderProgress();
  } catch (e) { /* 网络抖动：保留旧展示，下次轮询再试 */ }
}
function renderProgress() {
  const el = document.getElementById('orderProgress'); if (!el) return;
  const d = PROG.data;
  if (!PROG.id || !d) { el.innerHTML = ''; return; }
  const en = L === 'en';
  const steps = ['new', 'preparing', 'ready', 'done'];
  const idx = Math.max(0, steps.indexOf(d.status));
  const isPickup = d.fulfilment === 'pickup';
  const stateTxt = { new: t('progNew'), preparing: t('progPreparing'),
    ready: isPickup ? t('progReadyPickup') : t('progReadyDeliv'), done: t('progDone') }[d.status] || t('progNew');
  const when = [d.deliver_at, d.deliver_time].filter(Boolean).join(' ');
  const meta = [
    d.invoice_no ? `${t('payNo')} ${esc(d.invoice_no)}` : '',
    isPickup ? t('progPickupWord') : t('progDeliveryWord'),
    when ? `${t('progWhen')} ${esc(when)}` : '',
    (+d.delay_minutes > 0) ? `${t('progDelay')} ${Math.round(+d.delay_minutes)} ${t('progMin')}` : '',
  ].filter(Boolean).join(' · ');
  const canArrive = isPickup && !d.arrived && (d.status === 'preparing' || d.status === 'ready');
  el.innerHTML = `<div class="prog-card${d.status === 'ready' ? ' ready' : ''}">
    <div class="prog-head"><span class="prog-eyebrow">${t('progTitle')}</span>
      <button class="prog-x" id="progClose" aria-label="${en ? 'Hide' : '收起'}">×</button></div>
    <div class="prog-state">${stateTxt}</div>
    <div class="prog-steps">${steps.map((s, i) => `<div class="${i <= idx ? 'on' : ''}"></div>`).join('')}</div>
    <div class="prog-meta">${meta}</div>
    ${d.status_msg ? `<div class="prog-msg">${esc(d.status_msg)}</div>` : ''}
    ${canArrive ? `<button class="prog-arrive" id="progArrive">${t('progArrive')}</button>` : ''}
    ${(isPickup && d.arrived) ? `<div class="prog-note" style="color:${d.status === 'ready' ? '#fff' : 'var(--green-text,var(--green))'}">${t('progArrived')}</div>` : ''}
    ${PROG.note ? `<div class="prog-note" style="color:${d.status === 'ready' ? '#FFE7A8' : 'var(--red)'}">${esc(PROG.note)}</div>` : ''}
  </div>`;
  const x = document.getElementById('progClose'); if (x) x.onclick = () => progHide(true);
  const ab = document.getElementById('progArrive'); if (ab) ab.onclick = () => progArrive(ab);
}
// 「我到店了」：服务端只记一次(deduped)，前端仍按钮 disable + 处理中态防重复提交；429 提示稍后再试。
async function progArrive(btn) {
  if (!PROG.id || PROG.busy) return;
  PROG.busy = true; btn.disabled = true; btn.textContent = t('progArriving');
  PROG.note = '';
  try {
    const r = await fetch('/api/order/' + encodeURIComponent(PROG.id) + '/arrived', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) PROG.note = d.error || t('progArriveBusy');
    else if (!r.ok || !d.ok) PROG.note = d.error || t('progArriveFail');
    else if (PROG.data) PROG.data.arrived = true;            // 含 deduped：服务端已记过，同样算已告知
  } catch (e) {
    PROG.note = L === 'en' ? 'Network error — please try again.' : '网络异常，请稍后再试';
  }
  PROG.busy = false;
  renderProgress();   // 重绘会重建按钮，自然复位处理中态
}
function initOrderProgress() {
  const id = validOrderId(_deepOrderId) ? _deepOrderId : lastOrderId();   // 发票页深链 /?order=<id> 优先，其次本机最近一单
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) progStopPolling();
    else if (PROG.id && !PROG.done) { fetchProgress(); progStartPolling(); }
  });
  if (!id) return;
  rememberOrder(id);
  PROG.id = id; PROG.done = false; PROG.data = null; PROG.note = '';
  fetchProgress().then(() => progStartPolling());
}

// ---- 微信内置浏览器引导层 ----
// 微信 WebView 会拦掉 Google/Apple 的 OAuth 页面。只在【需要登录的动作】被触发时才弹，
// 浏览菜单 / 游客下单全程零阻塞。这里【绝不写任何自动跳转】——scheme/intent 在 iOS/Android
// 都会被微信拦下，写了只会让顾客更懵，只给「···→在浏览器中打开」的说明 + 复制链接兜底。
function isWeChatBrowser() { return /MicroMessenger/i.test(navigator.userAgent || ''); }
function isIosDevice() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}
window.wxBlockLogin = function (ev) {   // 挂在 Google/Apple 登录链接上：非微信一律放行
  if (!isWeChatBrowser()) return true;
  if (ev && ev.preventDefault) ev.preventDefault();
  showWxGuide();
  return false;
};
function hideWxGuide() { const s = document.getElementById('wxSheet'); if (s) s.classList.remove('show'); }
function showWxGuide() {
  const en = L === 'en', ios = isIosDevice();
  const stepIos = `<div class="wx-step"><b>iPhone / iPad</b><br>${t('wxIos')}</div>`;
  const stepAnd = `<div class="wx-step"><b>Android</b><br>${t('wxAndroid')}</div>`;
  document.getElementById('wxBody').innerHTML = `
    <h2>${t('wxTitle')}</h2>
    <p class="muted" style="font-size:13px;line-height:1.7">${t('wxWhy')}</p>
    ${ios ? stepIos + stepAnd : stepAnd + stepIos}
    <div class="wx-url">${esc(location.href)}</div>
    <button class="primary" id="wxCopyBtn" style="background:var(--gold2);color:var(--green-text,var(--green))">${t('wxCopy')}</button>
    <div id="wxCopyMsg" style="font-size:12.5px;margin-top:6px;min-height:16px"></div>
    <button class="primary" id="wxOkBtn">${t('wxClose')}</button>
    <p class="muted" style="margin-top:10px;line-height:1.6">${t('wxGuest')}</p>`;
  document.getElementById('wxSheet').classList.add('show');
  document.getElementById('wxOkBtn').onclick = hideWxGuide;
  document.getElementById('wxCopyBtn').onclick = () => copyPageLink();
}
async function copyPageLink() {
  const url = location.href;
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); ok = true; } } catch (e) {}
  if (!ok) {   // 微信 WebView 常拿不到 clipboard API：退回 execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, url.length);
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
  }
  const msg = document.getElementById('wxCopyMsg');
  if (msg) { msg.style.color = ok ? 'var(--green-text,var(--green))' : 'var(--red)'; msg.textContent = ok ? t('wxCopied') : t('wxCopyFail'); }
}

let TOPUP_TIERS = null;
// 储值档位随发布下发，不再有启动请求。
function loadTopupTiers() { renderTopupPromo(); }
function renderTopupPromo() {
  const el = document.getElementById('topupPromo'); if (!el) return;
  if (isPreviewPage()) { el.innerHTML = ''; return; }
  if (!TOPUP_TIERS || !TOPUP_TIERS.length) { el.innerHTML = ''; return; }
  const en = L === 'en';
  el.innerHTML = `<section class="sv-card"><div class="sv-title">${t('svTitle')}</div><div class="sv-hint">${t('svHint')}</div>
    <div class="sv-tiers">${TOPUP_TIERS.map(x => `<button type="button">${en ? 'Top up ' : '充 '}S$${esc(x.amount)}${+x.bonus ? ` <b>${en ? '+S$' : '送 S$'}${esc(x.bonus)}</b>` : ''}</button>`).join('')}</div>
    <div class="sv-cta"><span class="sv-fine">${t('svFine')}</span><button type="button" class="sv-go">${t('topupGo')}</button></div></section>`;
  el.querySelectorAll('button').forEach(b => { b.onclick = goTopup; });
}
async function goTopup() {
  if (isPreviewPage()) return;
  const sheet = document.getElementById('memberSheet'); sheet.classList.add('show');
  if (!authToken()) { loginView(); if (isWeChatBrowser()) showWxGuide(); return; }
  await loadProfile();
  await showTopup();
}

// ---- member centre (authenticated) ----
const memberSheet = document.getElementById('memberSheet');
memberSheet.onclick = e => { if (e.target.id === 'memberSheet') memberSheet.classList.remove('show'); };
const authToken = () => localStorage.getItem('hl_token') || '';
let MEMBER_SUMMARY = null;
function renderMemberButton() {
  const btn = document.getElementById('memberBtn');
  if (!btn) return;
  btn.disabled = isPreviewPage();
  btn.textContent = MEMBER_SUMMARY
    ? `${t('member')} · S$ ${(+MEMBER_SUMMARY.balance || 0).toFixed(2)}`
    : t('member');
}
async function refreshMemberSummary() {
  const tk = authToken();
  if (!tk) { MEMBER_SUMMARY = null; renderMemberButton(); return; }
  try {
    const r = await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + tk } });
    if (r.status === 401) { localStorage.removeItem('hl_token'); MEMBER_SUMMARY = null; renderMemberButton(); return; }
    const d = await r.json();
    MEMBER_SUMMARY = d.member || null;
  } catch (e) { MEMBER_SUMMARY = null; }
  renderMemberButton();
}
document.getElementById('wxSheet').onclick = e => { if (e.target.id === 'wxSheet') hideWxGuide(); };
// 需要登录的动作才可能弹微信引导层：未登录点「会员」= 要走 OAuth，先讲清楚怎么在浏览器打开。
document.getElementById('memberBtn').onclick = () => {
  if (isPreviewPage()) return;
  memberSheet.classList.add('show');
  if (authToken()) { loadProfile(); return; }
  loginView();
  if (isWeChatBrowser()) showWxGuide();
};

window.loginView = () => {
  document.getElementById('memberBody').innerHTML = `
    <h2>${t('loginFirst')}</h2>
    ${isWeChatBrowser() ? `<div class="wx-step" style="background:#FFF9EC"><b>${t('wxTitle')}</b><br>${t('wxWhy')}
      <a onclick="showWxGuide()" style="display:inline-block;margin-top:6px;color:var(--green-text,var(--green));font-weight:800;cursor:pointer">${L === 'en' ? 'How to open in a browser →' : '查看怎么在浏览器打开 →'}</a></div>` : ''}
    <a href="/api/auth/google" onclick="return wxBlockLogin(event)" class="primary" style="display:block;text-align:center;text-decoration:none;background:#fff;color:#333;border:1px solid #ccc">G&nbsp; ${t('google')}</a>
    <a href="/api/auth/apple" onclick="return wxBlockLogin(event)" class="primary" style="display:block;text-align:center;text-decoration:none;background:#000;color:#fff;margin-top:9px">&nbsp; ${t('apple')}</a>
    <p class="muted" style="font-size:12px;margin-top:12px;text-align:center;line-height:1.6">${L==='en'?"Google or Apple is enough to sign in. Phone is optional contact information.<br>Guest checkout is still available.":'Google 或 Apple 任一账号即可登录；手机号只是可选联系资料。<br>仍然可以不登录直接下单。'}</p>`;
};
window.forgotView = () => {
  document.getElementById('memberBody').innerHTML = `
    <h2>${t('loginFirst')}</h2>
    <p class="muted" style="font-size:13px;line-height:1.7">${L==='en'?'Recover access through the Google or Apple account you linked, then sign in again.':'请通过已绑定的 Google 或 Apple 账号找回访问权限，再回本站登录。'}</p>
    <a href="/api/auth/google" onclick="return wxBlockLogin(event)" class="primary" style="display:block;text-align:center;text-decoration:none;margin-top:10px">G&nbsp; ${t('google')}</a>
    <a href="/api/auth/apple" onclick="return wxBlockLogin(event)" class="primary" style="display:block;text-align:center;text-decoration:none;background:#000;color:#fff;margin-top:9px">&nbsp; ${t('apple')}</a>
    <a onclick="loginView()" style="color:var(--green-text,var(--green));cursor:pointer;font-size:13px;display:inline-block;margin-top:8px">← ${t('login')}</a>
    <div id="ferr" style="color:var(--red);font-size:13px;margin-top:6px"></div>`;
};
async function loadProfile() {
  const box = document.getElementById('memberBody'); box.innerHTML = `<p class="muted">${t('querying')}</p>`;
  const r = await fetch('/api/auth/me',{headers:{authorization:'Bearer '+authToken()}});
  if (r.status===401){ localStorage.removeItem('hl_token'); return loginView(); }
  const d = await r.json(), m = d.member;
  MEMBER_SUMMARY = m;
  renderMemberButton();
  const linked = new Set((d.providers||[]).map(x=>x.provider));
  const providerControls = ['google','apple'].map(p => linked.has(p)
    ? `<span style="padding:7px 10px;border-radius:9px;background:#edf6ef;color:var(--green-text,var(--green));font-size:12px">✓ ${p==='google'?'Google':'Apple'}</span>`
    : `<button type="button" class="link-provider" data-provider="${p}" style="padding:7px 10px;border:1px solid #ccc;border-radius:9px;background:#fff;font-size:12px">${L==='en'?'Link':'绑定'} ${p==='google'?'Google':'Apple'}</button>`).join(' ');
  const hist = (d.recent||[]).map(o=>`<a class="line" href="/invoice/${esc(o.id)}" target="_blank" style="display:flex;justify-content:space-between;text-decoration:none;color:inherit"><span>${esc(o.invoice_no)} · ${sgtDate(o.created_at)}</span><span>S$ ${o.total.toFixed(2)} · ${o.pay_status==='PAID'?t('paid'):t('unpaid')}</span></a>`).join('')||`<p class="muted">${t('noOrders')}</p>`;
  // 后端说 balance_after 不可信时，entries 里根本没有这个字段 —— 那就整列不显示，
  // 并明说请联系本店核对；绝不能拿 0/undefined 冒充「变动后余额」。
  const balAfterOk = !!(d.wallet && d.wallet.balance_after_reliable);
  const walletHist = ((d.wallet && d.wallet.entries) || []).map(e => {
    const delta = +(e.delta || 0), credit = delta >= 0;
    const kind = ({ topup: L==='en'?'Top-up credited':'充值入账', spend: L==='en'?'Balance spent':'消费抵扣', refund: L==='en'?'Refund credited':'退款入账', adjustment: L==='en'?'Balance adjustment':'余额调整' })[e.kind] || esc(e.kind || (L==='en'?'Wallet event':'余额变动'));
    const method = ({ stripe:'Stripe', cash:L==='en'?'Cash':'现金', paynow:'PayNow', manual_qr:'PayNow', balance:L==='en'?'Balance':'储值余额', wallet:L==='en'?'Wallet':'余额账本' })[e.method] || esc(e.method || '');
    const status = ({ PAID:L==='en'?'Paid':'已完成', UNPAID:L==='en'?'Pending':'待付余款', CANCELLED:L==='en'?'Cancelled':'已取消', REFUNDED:L==='en'?'Refunded':'已退款', COMPLETED:L==='en'?'Completed':'已完成' })[e.status] || esc(e.status || '');
    const reason = ({ stripe_expired:L==='en'?'Payment expired; balance returned':'支付超时，余额已退回', stripe_charge_refunded:L==='en'?'Order refunded':'订单退款', cron_timeout:L==='en'?'Order timed out; balance returned':'订单超时，余额已退回', admin:L==='en'?'Manual refund':'人工退款' })[e.note] || esc(e.note || '');
    const amount = `${credit?'+':'−'}S$ ${Math.abs(delta).toFixed(2)}`;
    const orderRef = e.order_id ? `<a href="/invoice/${esc(e.order_id)}" target="_blank" style="color:inherit;font-weight:700">${esc(e.invoice_no || e.order_id)}</a>` : '';
    const topupParts = e.kind === 'topup' ? `${L==='en'?'Paid':'本金'} S$${(+e.principal||0).toFixed(2)}${+e.bonus>0?` + ${L==='en'?'bonus':'赠送'} S$${(+e.bonus).toFixed(2)}`:''}` : '';
    const details = [orderRef, topupParts, method, status, reason].filter(Boolean).join(' · ');
    return `<div style="border:1px solid ${credit?'#8BB89A':'#E5AAA1'};background:${credit?'#EDF6EF':'#FFF3F0'};border-radius:10px;padding:10px;margin:7px 0">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:start"><div><b style="color:#1C4A3A">${kind}</b><div style="font-size:11px;color:var(--muted);margin-top:2px">${sgtDateTime(e.created_at)} SGT</div></div>
      <div style="text-align:right"><b style="font-size:17px;color:${credit?'#176B3A':'#A23B2D'}">${amount}</b>${balAfterOk?`<div style="font-size:11px;color:var(--muted)">${L==='en'?'Balance after':'变动后余额'} S$ ${(+e.balance_after||0).toFixed(2)}</div>`:''}</div></div>
      ${details?`<div style="font-size:12px;line-height:1.5;margin-top:6px;color:#4F493B">${details}</div>`:''}</div>`;
  }).join('') || `<p class="muted">${L==='en'?'No balance transactions yet.':'暂无储值变动。'}</p>`;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h2 style="border:none;margin:0;padding:0">${t('welcome')}${m.name?(L==='en'?', ':'，')+esc(m.name):''}</h2>
      <a onclick="doLogout()" style="color:var(--muted);cursor:pointer;font-size:13px">${t('logout')}</a></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">${providerControls}</div>
    ${d.legacy_pending ? `<div style="background:#FFF8EC;border:1px solid var(--gold2);border-radius:10px;padding:12px 14px;margin:8px 0">
      <div style="font-weight:700;color:#8A5A00;margin-bottom:4px">${L==='en'?'💰 You have stored value waiting to be linked':'💰 你有一笔历史储值还没并进来'}</div>
      <div style="font-size:14px;line-height:1.6">${L==='en'
        ? `Phone <b>${esc(d.legacy_pending.phone_mask)}</b> still has stored value from before we switched to Google/Apple sign-in. Please come to the shop — our staff will verify and merge it into this account. Your money is safe.`
        : `手机号 <b>${esc(d.legacy_pending.phone_mask)}</b> 上还有切换到 Google/Apple 登录之前充的储值。请到店让店员核验后帮你并到这个账号，钱不会丢。`}</div>
      <div class="contact-actions"><a href="${esc(contactInfo().whatsapp_href)}" target="_blank" rel="noopener">${L==='en'?'WhatsApp us':'WhatsApp 联系本店'}</a></div>
    </div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:end;margin-bottom:8px">
      <div class="field"><label>${t('name')}</label><input id="profileName" value="${esc(m.name||'')}" placeholder="${t('namePh')}"></div>
      <div class="field"><label>${t('birthday')}</label><input id="profileBirthday" type="date" value="${esc(m.birthday||'')}"></div>
      <div class="field" style="grid-column:1 / -1"><label>${t('phone')} <span style="color:var(--muted);font-weight:400">${L==='en'?'(optional, no verification)':'（可选，无需验证）'}</span></label><input id="profilePhone" inputmode="tel" value="${esc(m.phone||'')}" placeholder="+65 9123 4567"></div>
      <button class="primary" id="saveProfileBtn" style="grid-column:1 / -1">${t('saveProfile')}</button>
      <div id="profileMsg" class="muted" style="grid-column:1 / -1;font-size:12px"></div>
    </div>
    <div style="display:grid;grid-template-columns:.78fr 1.35fr;gap:8px;margin-bottom:8px">
      <div style="background:var(--green);color:#F4E7C8;border-radius:12px;padding:14px;text-align:center">
        <div style="font-size:12px;opacity:.85">${t('curPoints')}</div><div style="font-size:32px;font-weight:700;line-height:1.1">${m.points||0}</div><div style="font-size:11px;margin-top:3px">${d.tier}</div></div>
      <div style="background:var(--gold);color:#fff;border-radius:12px;padding:18px 14px;text-align:center;box-shadow:0 5px 16px rgba(185,138,47,.24)">
        <div style="font-size:13px;opacity:.95;font-weight:700">💳 ${t('balanceLabel')}</div><div style="font-size:40px;font-weight:850;line-height:1.12;letter-spacing:-1px">S$ ${(m.balance||0).toFixed(2)}</div>
        <button id="topupBtn" style="width:100%;min-height:44px;margin-top:9px;background:#fff;color:#7A5817;border:none;border-radius:22px;padding:9px 14px;font-weight:850;font-size:15px">${t('topup')} →</button></div>
    </div>
    <div id="topupArea"></div>
    <div style="font-size:11px;color:var(--muted);margin:4px 0 8px">${t('spent')} S$ ${(m.total_spent||0).toFixed(2)} · ${m.orders_count||0} ${t('ordersU')}</div>
    <div style="display:flex;justify-content:space-between;align-items:end;margin:10px 0 5px"><div style="font-weight:700;color:var(--green-text,var(--green))">${L==='en'?'Stored-value ledger':'储值账本'}</div><div style="font-size:11px;color:var(--muted)">${L==='en'?'Top-ups · spending · refunds':'充值 · 消费 · 退款'}${d.wallet&&d.wallet.truncated?(L==='en'?' · latest 500':' · 最近 500 笔'):''}</div></div>
    ${balAfterOk ? '' : `<div style="background:#FFF3F0;border:1px solid #E5AAA1;border-radius:10px;padding:9px 11px;font-size:12.5px;line-height:1.55;color:#A23B2D;margin-bottom:4px">${t('walletNoBalance')}${contactActionsHtml(L === 'en')}</div>`}
    <div style="max-height:360px;overflow-y:auto;padding-right:2px">${walletHist}</div>
    <div style="font-weight:700;color:var(--green-text,var(--green));margin:6px 0">${t('recentOrders')}</div>${hist}`;
  document.getElementById('topupBtn').onclick = () => showTopup();
  document.getElementById('saveProfileBtn').onclick = saveProfile;
  box.querySelectorAll('.link-provider').forEach(b => b.onclick = () => linkProvider(b.dataset.provider));
}
window.saveProfile = async () => {
  const body = { name: document.getElementById('profileName').value.trim(), birthday: document.getElementById('profileBirthday').value || null, phone: document.getElementById('profilePhone').value.trim() || null };
  const r = await (await fetch('/api/auth/profile',{method:'POST',headers:{authorization:'Bearer '+authToken(),'content-type':'application/json'},body:JSON.stringify(body)})).json();
  document.getElementById('profileMsg').textContent = r.ok ? t('profileSaved') : (r.error || 'Error');
};
window.doLogout = () => { localStorage.removeItem('hl_token'); MEMBER_SUMMARY = null; renderMemberButton(); loginView(); };

async function showTopup() {
  if (isPreviewPage()) return;
  const area = document.getElementById('topupArea');
  area.innerHTML = `<p class="muted" style="font-size:12px">${t('topupHint')}</p><p class="muted">…</p>`;
  // 档位来自发布快照，会员面板也不用再打一次接口。
  const tiers = (TOPUP_TIERS || []).slice();
  area.innerHTML = `<div class="box" style="background:var(--cream2);border:1px solid var(--gold2);border-radius:10px;padding:10px;margin:6px 0">
    <div style="font-weight:700;color:var(--green-text,var(--green));margin-bottom:6px">${t('topupTitle')}</div>
    <p class="muted" style="font-size:12px;margin-bottom:8px">${t('topupHint')}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${tiers.map(x => `<button class="topup-opt" data-amt="${x.amount}" style="border:1px solid var(--gold2);background:#fff;border-radius:10px;padding:10px;font-weight:700">${L==='en'?'Top up':'充'} S$${x.amount}${x.bonus ? ` <span style="color:var(--red)">${L==='en'?`+$${x.bonus} free`:`送 $${x.bonus}`}</span>` : ''}</button>`).join('')}
    </div></div>`;
  // 动钱的按钮：整组 disable + 处理中态，防连点开出多张 Stripe 充值单；失败才恢复（成功会直接跳走）
  area.querySelectorAll('.topup-opt').forEach(b => b.onclick = async () => {
    const opts = area.querySelectorAll('.topup-opt');
    if (b.disabled) return;
    const old = b.innerHTML;
    opts.forEach(o => o.disabled = true);
    b.textContent = '…';
    try {
      const r = await (await fetch('/api/topup/checkout', { method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+authToken()}, body: JSON.stringify({ amount: +b.dataset.amt }) })).json();
      if (r.checkout_url && /^https:\/\//.test(r.checkout_url)) { window.location.href = r.checkout_url; return; }
      alert(r.error || (L==='en'?'Top-up failed':'充值失败'));
    } catch (e) {
      alert(L==='en'?'Network error — please try again.':'网络异常，请稍后再试');
    }
    b.innerHTML = old;
    opts.forEach(o => o.disabled = false);
  });
}

window.linkProvider = async provider => {
  if (isWeChatBrowser()) { showWxGuide(); return; }   // 绑定同样要跳 OAuth，微信里必然失败 → 先引导，不做任何自动跳转
  const r = await fetch('/api/auth/link-start', { method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+authToken()}, body:JSON.stringify({provider}) });
  const d = await r.json();
  if (d.url) location.href = d.url;
  else alert(d.error || (L==='en'?'Unable to link account':'暂时无法绑定账号'));
};
// OAuth tokens are returned in the URL fragment so they are not sent in HTTP
// requests or Referer headers. Clean the fragment immediately after reading.
(function(){
  const h = new URLSearchParams(location.hash.replace(/^#/,''));
  const q = new URLSearchParams(location.search); // compatibility with an in-flight old Google callback
  const token = h.get('auth_token') || q.get('gtoken');
  const linked = h.get('auth_linked');
  const authError = h.get('auth_error');
  if (token) localStorage.setItem('hl_token', token);
  if (token || linked || authError) {
    history.replaceState({},'',location.pathname);
    setTimeout(()=>{
      memberSheet.classList.add('show');
      if (authError) { authToken() ? loadProfile() : loginView(); alert(L==='en'?'Sign-in failed. Please try again.':'登录失败，请重试。'); }
      else loadProfile();
    }, 200);
  }
})();

// init language from saved preference, then load menu
if (L === 'en') setLang('en'); else { document.getElementById('langBtn').textContent = 'EN'; }
load();
if (isPreviewPage()) renderMemberButton();
else {
  refreshMemberSummary();
  initOrderProgress();   // 深链 /?order=<id> 或本机最近一单 → 顶部显示制作进度卡
}
