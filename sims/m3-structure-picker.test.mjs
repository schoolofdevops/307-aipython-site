#!/usr/bin/env node
// Headless-Chrome assertion harness for m3-structure-picker.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m3-structure-picker.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm3-structure-picker.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9740 + (process.pid % 400);

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!CHROME) { console.error('No Chrome/Chromium found'); process.exit(2); }

let PASS = 0, FAIL = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; results.push('  PASS  ' + name); }
  else { FAIL++; results.push('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

// ---- minimal CDP over WebSocket (RFC6455 client, no deps) ----
function httpJSON(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve(b); }
      });
    });
    req.on('error', reject); req.end();
  });
}
function connectWS(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Origin: http://127.0.0.1:${PORT}\r\n\r\n`);
    });
    let handshaken = false; let buf = Buffer.alloc(0);
    const listeners = new Map(); let idc = 1; const evwaiters = [];
    function send(method, params = {}, sessionId) {
      const id = idc++; const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      sock.write(encodeFrame(JSON.stringify(msg)));
      return new Promise(res => listeners.set(id, res));
    }
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        handshaken = true; buf = buf.slice(idx + 4);
        resolve({ send, onEvent: (m, cb) => evwaiters.push({ m, cb }), close: () => sock.destroy() });
      }
      let f;
      while ((f = decodeFrame(buf))) {
        buf = f.rest;
        if (f.opcode === 8) { sock.destroy(); break; }
        if (f.opcode === 1 || f.opcode === 2) {
          let m; try { m = JSON.parse(f.payload.toString()); } catch { continue; }
          if (m.id && listeners.has(m.id)) { listeners.get(m.id)(m); listeners.delete(m.id); }
          if (m.method) evwaiters.filter(w => w.m === m.method).forEach(w => w.cb(m.params));
        }
      }
    });
    sock.on('error', reject);
  });
}
function encodeFrame(str) {
  const p = Buffer.from(str); const len = p.length;
  const mask = crypto.randomBytes(4); let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f; const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f; let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let mask; if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (masked) { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i & 3]; payload = o; }
  return { opcode, payload, rest: buf.slice(off + len) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    '--no-sandbox', '--disable-gpu', '--window-size=800,500',
    '--user-data-dir=/tmp/m3-structure-picker-chrome-' + process.pid, 'about:blank',
  ], { stdio: 'ignore' });

  let version;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJSON('GET', '/json/version'); if (version && version.webSocketDebuggerUrl) break; } catch {}
    await sleep(150);
  }
  if (!version || !version.webSocketDebuggerUrl) { console.error('devtools endpoint never came up'); child.kill('SIGKILL'); process.exit(2); }

  const tab = await httpJSON('PUT', '/json/new?' + encodeURIComponent(FILE_URL));
  const cdp = await connectWS(tab.webSocketDebuggerUrl);

  const consoleErrors = [], pageErrors = [], netRequests = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  cdp.onEvent('Runtime.consoleAPICalled', p => { if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args)); });
  cdp.onEvent('Runtime.exceptionThrown', p => pageErrors.push(p.exceptionDetails && p.exceptionDetails.text));
  cdp.onEvent('Network.requestWillBeSent', p => {
    const u = p.request.url;
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('about:')) netRequests.push(u);
  });

  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 800, height: 500, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: FILE_URL });
  await sleep(700);

  async function ev(expr) {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    if (r.result && r.result.result) return r.result.result.value;
    return undefined;
  }
  const logHas = re => ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return ${re}.test(e.textContent)})`);

  // ---------- 1. loads clean (R1) ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — four structure options present', (await ev('document.querySelectorAll("#opts .opt").length')) === 4);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affOpts = await ev(`(function(){var bad=[];
    document.querySelectorAll('#opts .opt').forEach(function(e){
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push('cursor='+cs.cursor);
      if(!e.title)bad.push('no-title');
    });return bad;})()`);
  ok('R2 structure buttons have pointer cursor + tooltip', affOpts.length === 0, affOpts.join(','));
  const affReset = await ev(`(function(){var e=document.getElementById('reset');
    return {cur:getComputedStyle(e).cursor,tip:!!e.title};})()`);
  ok('R2 Reset is affordant (pointer + title)', affReset.cur === 'pointer' && affReset.tip, JSON.stringify(affReset));
  const inert = await ev(`(function(){return {
    card:getComputedStyle(document.getElementById('cardBody')).cursor,
    meter:getComputedStyle(document.getElementById('verdict')).cursor,
    log:getComputedStyle(document.getElementById('evList')).cursor};})()`);
  ok('R2 card / meter / event log are inert (cursor:default)',
    inert.card === 'default' && inert.meter === 'default' && inert.log === 'default', JSON.stringify(inert));
  const sigHelp = await ev(`getComputedStyle(document.querySelector('#cardSigs .sig')).cursor`);
  ok('R2 signal chips read as tooltip-only (cursor:help)', sigHelp === 'help', sigHelp);
  ok('R8 honest-model footnote present + tooltip',
    await ev(`(function(){var n=document.getElementById('note');return !!n && /single-structure fit only/.test(n.textContent) && !!n.title;})()`) === true);

  // ---------- 3. structural teaching invariants (the regression teeth) ----------
  const invMut = await ev(`(function(){var C=window.__sim.COST;
    return C[2].mut<C[0].mut && C[2].mut<C[1].mut && C[2].mut<C[3].mut;})()`);
  ok('INVARIANT tuple is uniquely lowest mutation/key-safety risk', invMut === true);
  const invDup = await ev(`(function(){var C=window.__sim.COST;
    return C[3].dup<C[0].dup && C[3].dup<C[2].dup;})()`);
  ok('INVARIANT set is uniquely lowest duplicate risk', invDup === true);
  const invLookup = await ev(`(function(){var C=window.__sim.COST;
    return C[1].lookup<C[0].lookup && C[1].lookup<C[2].lookup && C[1].lookup<C[3].lookup;})()`);
  ok('INVARIANT dict is uniquely lowest named-lookup cost', invLookup === true);
  const invOrder = await ev(`(function(){var C=window.__sim.COST;
    return C[3].order>C[0].order && C[3].order>C[1].order && C[3].order>C[2].order;})()`);
  ok('INVARIANT set is uniquely highest order-loss risk', invOrder === true);

  // ---------- 4. wrong pick on card 1 (DS-101, needs dict): meter + verdict + domain log ----------
  ok('boot: first scenario is DS-101', (await ev('window.__sim.currentCard().id')) === 'DS-101');
  await ev('document.querySelectorAll("#opts .opt")[0].click()'); // List — wrong, needs Dict
  await sleep(150);
  const wrongState = await ev(`(function(){var W=window.__sim;return {
    verdict:document.getElementById('verdict').textContent,
    cls:document.getElementById('verdict').className,
    picked:W.S.picked, answered:W.S.answered, streak:W.S.streak,
    nextShown:document.getElementById('nextBtn').classList.contains('show')};})()`);
  ok('wrong-pick verdict names the miss', /WRONG STRUCTURE.*List.*Dict/.test(wrongState.verdict) && wrongState.cls === 'bad',
    JSON.stringify(wrongState));
  ok('wrong answer resets streak + reveals Next-scenario', wrongState.streak === 0 && wrongState.nextShown === true);
  ok('event log narrates the miss in Python/ops language',
    (await logHas('/jump straight to the answer|scans from the top/')) === true);
  const recycled = await ev(`(function(){var W=window.__sim;var q=W.S.queue;
    return W.CARDS[q[q.length-1]].id;})()`);
  ok('missed scenario recycles to the bottom of the deck', recycled === 'DS-101', recycled);
  const nextAff = await ev(`(function(){var e=document.getElementById('nextBtn');
    return {cur:getComputedStyle(e).cursor,tip:!!e.title};})()`);
  ok('R2 Next-scenario button is affordant (pointer + title)', nextAff.cur === 'pointer' && nextAff.tip, JSON.stringify(nextAff));
  const tickShown = await ev(`document.getElementById('tLookup').classList.contains('show')`);
  ok('consequences meter shows a "fits" tick after an answer', tickShown === true);
  const fills = await ev(`(function(){return ['fLookup','fDup','fMut','fOrder'].map(function(i){
    return parseFloat(getComputedStyle(document.getElementById(i)).width)||0;});})()`);
  // DS-101's wrong pick (List) has a legitimately tiny order-loss cost (5%, list preserves order) —
  // assert non-zero rendering, not a magnitude, since that dimension is meant to read as "fine" here.
  ok('consequences meter fills render with non-zero width', fills.every(w => w > 0), JSON.stringify(fills));

  // ---------- 5. correct answer path ----------
  await ev('document.getElementById("nextBtn").click()'); await sleep(100);
  ok('next deal serves DS-114', (await ev('window.__sim.currentCard().id')) === 'DS-114');
  await ev('document.querySelectorAll("#opts .opt")[0].click()'); // List — correct (ordered patch queue)
  await sleep(150);
  const rightState = await ev(`(function(){var W=window.__sim;return {
    verdict:document.getElementById('verdict').textContent, streak:W.S.streak,
    retired:W.S.retired.length};})()`);
  ok('right-structure verdict + streak increments + scenario retires',
    /RIGHT STRUCTURE/.test(rightState.verdict) && rightState.streak === 1 && rightState.retired === 1,
    JSON.stringify(rightState));
  ok('event log narrates the right-structure outcome (canary...)', (await logHas('/canary-first plan survives/')) === true);

  // ---------- 6. full TRY-THIS run with predict-first (fresh page) ----------
  await ev('location.reload()'); await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT step 1 opens with question + chips', pBoot.chips === 2 && /Predict first/.test(pBoot.txt), JSON.stringify(pBoot));
  ok('PREDICT instruction hidden until a prediction is made', !/Classify/.test(pBoot.txt), pBoot.txt);
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor,tip:!!c.title};})()`);
  ok('PREDICT chips are affordant (pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // tap the WRONG chip (idx 0 — "How the data looks on the page"; correct is 1)
  await ev(`document.querySelectorAll('#chPredict .chip')[0].click()`); await sleep(80);
  const pAfter = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT tap reveals instruction + names your pick',
    pAfter.chips === 0 && /Classify/.test(pAfter.txt) && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT pick is logged in the ops stream', (await logHas('/you predicted/')) === true);

  // Step 1: three correct in a row (DS-101→Dict, DS-114→List, DS-127→Dict)
  const answer = async (visIdx) => {
    await ev(`document.querySelectorAll("#opts .opt")[${visIdx}].click()`);
    await sleep(80);
    await ev('document.getElementById("nextBtn").click()');
    await sleep(80);
  };
  await answer(1); // Dict for DS-101
  await answer(0); // List for DS-114
  await ev('document.querySelectorAll("#opts .opt")[1].click()'); await sleep(120); // Dict for DS-127
  let st = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected (3 correct in a row)', st >= 2, 'step=' + st);
  ok('PREDICT wrong pick never blocks; verdict names it and teaches',
    (await logHas('/Not what you predicted.*data looks/')) === true);
  // Step 2: dedup trap DS-133. Predict RIGHT via the hook (idx 1), then answer Set.
  await ev('window.__sim.predict(1)');
  await ev('document.getElementById("nextBtn").click()'); await sleep(80);
  ok('trap scenario DS-133 is on the table', (await ev('window.__sim.currentCard().id')) === 'DS-133');
  await ev('document.querySelectorAll("#opts .opt")[3].click()'); await sleep(120); // Set — correct
  st = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 2 auto-detected (dedup trap beaten)', st >= 3, 'step=' + st);
  ok('PREDICT right pick confirmed in the log', (await logHas('/Prediction right/')) === true);
  // Step 3: dict-key trap DS-145 — skip the prediction entirely (formative, never blocking)
  await ev('document.getElementById("nextBtn").click()'); await sleep(80);
  ok('trap scenario DS-145 is on the table', (await ev('window.__sim.currentCard().id')) === 'DS-145');
  await ev('document.querySelectorAll("#opts .opt")[2].click()'); await sleep(120); // Tuple — correct
  const doneState = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success'),
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('TRY-THIS step 3 auto-detected with prediction skipped (never blocks)', doneState.step === 4, JSON.stringify(doneState));
  ok('CHALLENGE success banner states the takeaway',
    doneState.success === true && /operation/.test(doneState.txt), doneState.txt.slice(0, 160));
  const dots = await ev(`['d1','d2','d3'].map(function(i){return document.getElementById(i).className})`);
  ok('all three dots marked done', dots.every(c => /done/.test(c)), JSON.stringify(dots));

  // ---------- 7. trap completion cannot be spoofed by a wrong pick ----------
  await ev('location.reload()'); await sleep(600);
  // answer the first three correctly to reach DS-133 (step 2), then pick List (wrong — the dedup trap)
  await answer(1); await answer(0); await answer(1); // 3 correct → step 2
  await ev('document.querySelectorAll("#opts .opt")[0].click()'); await sleep(120); // List on DS-133 = the dedup trap
  const trapMiss = await ev(`(function(){var W=window.__sim;return {step:W.CH.step,dedupOK:W.CH.dedupOK,
    verdict:document.getElementById('verdict').textContent};})()`);
  ok('falling for the dedup trap does NOT complete step 2',
    trapMiss.step === 2 && trapMiss.dedupOK === false && /WRONG STRUCTURE/.test(trapMiss.verdict), JSON.stringify(trapMiss));
  ok('dedup-trap miss narrated in Python/ops language (duplicates slip through)', (await logHas('/duplicates slip through|growing pile/')) === true);

  // ---------- 8. Reset (R5) ----------
  await ev('document.getElementById("reset").click()'); await sleep(600);
  const afterReset = await ev(`(function(){var W=window.__sim;return {
    card:W.currentCard().id, step:W.CH.step, streak:W.S.streak, retired:W.S.retired.length,
    answered:W.S.answered, verdict:document.getElementById('verdict').textContent};})()`);
  ok('R5 Reset returns to initial state', afterReset.card === 'DS-101' && afterReset.step === 1
    && afterReset.streak === 0 && afterReset.retired === 0 && afterReset.answered === false
    && /pick a structure/.test(afterReset.verdict), JSON.stringify(afterReset));

  // ---------- 9. fits the frame (R3) ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @800x500', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @800x500', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 10. prefers-reduced-motion (R4) ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedBad = await ev(`(function(){var bad=0;
    document.querySelectorAll('*').forEach(function(el){var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad++;});
    return bad;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedBad === 0, 'active=' + reducedBad);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m3-structure-picker-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
