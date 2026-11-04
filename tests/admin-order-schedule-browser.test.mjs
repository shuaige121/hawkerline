import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import puppeteer from 'puppeteer-core';
import { findChrome } from './find-chrome.mjs';
import worker from '../worker/index.js';

test('desktop/mobile dashboard: real order route, schedule, filters, refresh and layout', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE orders(id TEXT,invoice_no TEXT,created_at TEXT,deliver_at TEXT,deliver_time TEXT,pay_status TEXT,source TEXT,fulfil_status TEXT,fulfilment TEXT,customer_name TEXT,items_json TEXT,total REAL);
    CREATE TABLE order_events(id TEXT,order_id TEXT,type TEXT); CREATE TABLE order_refunds(order_id TEXT,status TEXT);`);
  const tomorrow=new Date(Date.now()+8*3600e3+86400e3).toISOString().slice(0,10);   // Singapore date; upcoming orders sort ascending
  for (let i=0;i<36;i++) db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    `test-${i}`, `TEST-${String(i).padStart(2,'0')}`, `2026-09-${String(22-i%10).padStart(2,'0')}T01:00:00Z`,
    tomorrow, `${String(9+Math.floor(i/6)).padStart(2,'0')}:${String(i%6*10).padStart(2,'0')}`,
    i%2 ? 'UNPAID':'PAID', 'online', i%3 ? 'new':'ready', i%2 ? 'pickup':'discount',
    '验收测试顾客', JSON.stringify([{name:'招牌鲜肉包',qty:2}]), 7.2);
  // Recent past orders must not displace upcoming ones from the default 30-row view.
  for (const [id,days] of [['past-1',1],['past-2',2]]) {
    const d=new Date(Date.now()+8*3600e3-days*86400e3).toISOString().slice(0,10);
    db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id.toUpperCase(),new Date().toISOString(),d,'08:00',
      'CANCELLED','online','new','pickup','验收测试顾客',JSON.stringify([{name:'招牌鲜肉包',qty:1}]),3.6);
  }
  const DB = {prepare(sql) {let args=[];return {bind(...a){args=a;return this;},async all(){return {results:db.prepare(sql).all(...args)};}};}};
  const fixtures = {
    '/api/admin/summary': {paid_revenue:129.6,paid_orders:18,future_orders:36},
    '/api/admin/production': {total:72,gifts:0,date:'2026-09-23',buns:[{name:'不应显示的图表商品',qty:72}]},
    '/api/admin/settings': {config:{store_open:true}},
    '/api/admin/online-topup-intents': {intents:[]},
    '/api/admin/audit': {label:'2026-09-23',paid_orders:18,revenue:129.6,online:{orders:18,revenue:129.6},offline:{orders:0,revenue:0},unpaid:18},
  };
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/admin') {res.setHeader('content-type','text/html; charset=utf-8');res.end(readFileSync(new URL('../web/admin.html',import.meta.url)));return;}
    if(url.pathname.startsWith('/vendor/')) {res.setHeader('content-type',url.pathname.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(new URL('../web'+url.pathname,import.meta.url)));return;}
    if(url.pathname==='/api/admin/orders') {
      const r=await worker.fetch(new Request(url,{headers:{authorization:'Bearer browser-test'}}),{ADMIN_TOKEN:'browser-test',DB},{});
      res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());return;
    }
    if(fixtures[url.pathname]) {res.setHeader('content-type','application/json');res.end(JSON.stringify(fixtures[url.pathname]));return;}
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await puppeteer.launch({executablePath:findChrome(),headless:true});
    mkdirSync('_qa/order-schedule',{recursive:true});
    for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
      const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.setViewport({width,height,deviceScaleFactor:1});
      await page.evaluateOnNewDocument(()=>sessionStorage.setItem('hl_admin','browser-test'));
      await page.goto(`http://127.0.0.1:${server.address().port}/admin`,{waitUntil:'networkidle0'});
      const rows=()=>page.$$eval('.ordtbl tbody tr:has(td > a)',rs=>rs.map(r=>r.querySelector('td a')?.textContent));
      assert.deepEqual(await rows(),Array.from({length:30},(_,i)=>`TEST-${String(i).padStart(2,'0')}`));
      assert.equal(await page.evaluate(()=>document.body.innerText.includes('今日各包子备货量')),false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'page must not overflow');
      await page.screenshot({path:`_qa/order-schedule/${name}-top.png`});
      await page.$eval('#auditOut',el=>el.scrollIntoView());
      await page.screenshot({path:`_qa/order-schedule/${name}-chart-removed.png`});
      await page.$eval('.filters',el=>el.scrollIntoView());
      await page.screenshot({path:`_qa/order-schedule/${name}-orders.png`});
      if(name==='mobile') {
        const scrolled=await page.$eval('.ordtbl',table=>{const box=table.parentElement;box.scrollLeft=box.scrollWidth;return box.scrollLeft>0;});
        assert.equal(scrolled,true,'mobile order table must scroll horizontally');
        await page.screenshot({path:`_qa/order-schedule/${name}-actions.png`});
        await page.$eval('.ordtbl',table=>{table.parentElement.scrollLeft=table.rows[0].cells[5].offsetLeft-table.offsetLeft;});
        await page.screenshot({path:`_qa/order-schedule/${name}-schedule.png`});
      }
      await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.includes('查看全部')).click());
      await page.waitForFunction(()=>document.querySelectorAll('.ordtbl tbody tr:has(td > a)').length===38);
      assert.deepEqual((await rows()).slice(36),['PAST-1','PAST-2']);
      await page.select('#f','PAID');
      await page.waitForFunction(()=>document.querySelectorAll('.ordtbl tbody tr:has(td > a)').length===18);
      await page.select('#ff','ready');
      await page.waitForFunction(()=>document.querySelectorAll('.ordtbl tbody tr:has(td > a)').length===6);
      assert.deepEqual(await rows(),[0,6,12,18,24,30].map(i=>`TEST-${String(i).padStart(2,'0')}`));
      await page.click('.filters button');await page.waitForNetworkIdle();
      assert.equal((await rows()).length,6);
      await page.reload({waitUntil:'networkidle0'});assert.equal((await rows()).length,30);
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));db.close();}
});
