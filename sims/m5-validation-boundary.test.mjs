#!/usr/bin/env node
// Headless-Chrome assertion harness for m5-validation-boundary.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m5-validation-boundary.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm5-validation-boundary.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9340 + (process.pid % 400);

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
    '--no-sandbox', '--disable-gpu', '--window-size=900,560',
    '--user-data-dir=/tmp/m5-validation-boundary-chrome-' + process.pid, 'about:blank',
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
    { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
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
  ok('renders — 3 verdict options present', (await ev('document.querySelectorAll("#opts .opt").length')) === 3);
  ok('12 packets loaded', (await ev('window.__sim.CARDS.length')) === 12);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affOpts = await ev(`(function(){var bad=[];
    document.querySelectorAll('#opts .opt').forEach(function(e){
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push('cursor='+cs.cursor);
      if(!e.title)bad.push('no-title');
    });return bad;})()`);
  ok('R2 verdict buttons have pointer cursor + tooltip', affOpts.length === 0, affOpts.join(','));
  const affMode = await ev(`(function(){var bad=[];
    ['modeLenient','modeStrict','reset','nextBtn'].forEach(function(id){
      var e=document.getElementById(id),cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(id+':cursor='+cs.cursor);
      if(!e.title)bad.push(id+':no-title');
    });return bad;})()`);
  ok('R2 mode switch / reset / next are affordant (pointer + title)', affMode.length === 0, affMode.join(','));
  const inert = await ev(`(function(){return {
    card:getComputedStyle(document.getElementById('cardBody')).cursor,
    verdict:getComputedStyle(document.getElementById('vLabel')).cursor,
    log:getComputedStyle(document.getElementById('evList')).cursor};})()`);
  ok('R2 packet card / consequences / event log are inert (cursor:default)',
    inert.card === 'default' && inert.verdict === 'default' && inert.log === 'default', JSON.stringify(inert));
  ok('R8 honest-model footnote present + tooltip',
    await ev(`(function(){var n=document.getElementById('note');return !!n && /verified against real Pydantic v2/.test(n.textContent) && !!n.title;})()`) === true);

  // ---------- 3. teaching invariants -- the regression teeth ----------
  const invLiteral = await ev(`(function(){var c=window.__sim.CARDS.find(function(c){return c.id==='PKT-234'});
    return c.lenient.verdict==='reject' && c.strict.verdict==='reject';})()`);
  ok('INVARIANT Literal field rejects the same way in both modes (no coercion path exists to turn off)', invLiteral === true);
  const invExtra = await ev(`(function(){var c=window.__sim.CARDS.find(function(c){return c.id==='PKT-311'});
    return c.lenient.verdict==='pass' && c.strict.verdict==='pass';})()`);
  ok('INVARIANT unknown extra field is ignored in BOTH modes (strict does not forbid extras)', invExtra === true);
  const invStrNoCoerce = await ev(`(function(){var a=window.__sim.CARDS.find(function(c){return c.id==='PKT-278'});
    var b=window.__sim.CARDS.find(function(c){return c.id==='PKT-300'});
    return a.lenient.verdict==='reject' && b.lenient.verdict==='reject';})()`);
  ok('INVARIANT a str field never coerces from int/number, even in lenient mode', invStrNoCoerce === true);
  const invFlip = await ev(`(function(){var flips=window.__sim.CARDS.filter(function(c){
      return c.lenient.verdict!=='reject' && c.strict.verdict==='reject';});
    return flips.length>=3;})()`);
  ok('INVARIANT at least 3 packets flip verdict between lenient and strict (the switch has teeth)', invFlip === true);
  const invBoolTrap = await ev(`(function(){var c=window.__sim.CARDS.find(function(c){return c.id==='PKT-322'});
    return c.lenient.verdict==='coerce' && c.strict.verdict==='reject';})()`);
  ok('INVARIANT bool-as-int foot-gun (replicas:true) coerces lenient, rejects strict', invBoolTrap === true);

  // ---------- 4. boot state ----------
  ok('boot: first packet is PKT-201', (await ev('window.__sim.currentCard().id')) === 'PKT-201');
  ok('boot: mode starts LENIENT', (await ev('window.__sim.mode()')) === 'lenient');
  ok('boot: LENIENT button shows active state', (await ev(`document.getElementById('modeLenient').classList.contains('active')`)) === true);

  // ---------- 5. correct prediction path (PKT-201, clean packet, predict PASS) ----------
  await ev(`window.__sim.pick('pass')`); await sleep(120);
  const rightState = await ev(`(function(){var W=window.__sim;return {
    label:document.getElementById('vLabel').textContent, cls:document.getElementById('vLabel').className,
    streak:W.S.streak, solved:W.S.retired.size, nextShown:document.getElementById('nextBtn').classList.contains('show')};})()`);
  ok('correct PASS prediction: verdict shown + streak + solved increment', /PASS/.test(rightState.label) && rightState.cls === 'ok'
    && rightState.streak === 1 && rightState.solved === 1 && rightState.nextShown === true, JSON.stringify(rightState));
  ok('event log narrates the clean-pass outcome in ops language', (await logHas('/validated clean/')) === true);

  // ---------- 6. wrong prediction path (PKT-212 arrives next, predict REJECT — wrong, actual is COERCE) ----------
  await ev(`window.__sim.next()`); await sleep(100);
  ok('next deal serves PKT-212', (await ev('window.__sim.currentCard().id')) === 'PKT-212');
  await ev(`window.__sim.pick('reject')`); await sleep(120);
  const wrongState = await ev(`(function(){var W=window.__sim;return {
    label:document.getElementById('vLabel').textContent, streak:W.S.streak,
    queueTail:W.S.queue[W.S.queue.length-1]};})()`);
  ok('wrong prediction: verdict names the real outcome (COERCE) + resets streak', /COERCE/.test(wrongState.label) && wrongState.streak === 0, JSON.stringify(wrongState));
  ok('missed packet recycles to the bottom of the deck', (await ev(`window.__sim.CARDS[window.__sim.S.queue[window.__sim.S.queue.length-1]].id`)) === 'PKT-212');
  ok('event log narrates the miss (predicted REJECT, boundary actually coerces)', (await logHas('/you called REJECT.*actually COERCES/')) === true);
  ok('reveal shows the actual coercion detail even on a wrong guess',
    (await ev(`document.getElementById('vDetail').innerHTML`)).indexOf('3 (int)') !== -1);
  await ev(`window.__sim.next()`); await sleep(80); // move on; PKT-212 stays requeued for later

  // ---------- 7. PKT-223 -> PKT-234: Literal field verdict does NOT flip with mode (honesty check) ----------
  ok('next deal serves PKT-223', (await ev('window.__sim.currentCard().id')) === 'PKT-223');
  await ev(`window.__sim.pick('reject')`); await sleep(100); // correct, int_parsing
  await ev(`window.__sim.next()`); await sleep(80);
  ok('PKT-234 (environment Literal trap) is on the table', (await ev('window.__sim.currentCard().id')) === 'PKT-234');
  await ev(`window.__sim.pick('reject')`); await sleep(100);
  const litLenient = await ev(`document.getElementById('vLabel').textContent`);
  ok('PKT-234 rejects in lenient mode too (Literal has no coercion path)', /REJECT/.test(litLenient), litLenient);
  await ev(`window.__sim.setMode('strict')`); await sleep(100);
  ok('flipping mode reset PKT-234 for re-prediction', (await ev('window.__sim.S.answered')) === false);
  await ev(`window.__sim.pick('reject')`); await sleep(100);
  const litStrict = await ev(`document.getElementById('vLabel').textContent`);
  ok('PKT-234 still rejects in strict mode — same verdict, proving the switch has no effect here', /REJECT/.test(litStrict), litStrict);
  // NOTE: do not flip mode again here — the card is already answered, so a flip would just
  // arm another pending re-predict. Move on with mode still 'strict'; next() advances because
  // the current card is answered.
  await ev(`window.__sim.next()`); await sleep(80); // PKT-245 dealt, still in strict mode

  // ---------- 8. PKT-245 -> PKT-256: the mode switch — the key interactive, same packet, different outcome ----------
  ok('PKT-245 (missing field) is on the table', (await ev('window.__sim.currentCard().id')) === 'PKT-245');
  // flip back to lenient now, while PKT-245 is still FRESH/unanswered — this just changes
  // context for the next predict, no reset needed (missing-field rejects the same either way).
  await ev(`window.__sim.setMode('lenient')`); await sleep(80);
  await ev(`window.__sim.pick('reject')`); await sleep(100); // correct, missing (same verdict in lenient)
  await ev(`window.__sim.next()`); await sleep(80);
  ok('PKT-256 (port float, coercion + flip candidate) is on the table', (await ev('window.__sim.currentCard().id')) === 'PKT-256');
  await ev(`window.__sim.pick('coerce')`); await sleep(120); // correct in lenient
  const afterCoerce = await ev(`(function(){return {label:document.getElementById('vLabel').textContent,
    id:window.__sim.currentCard().id, answered:window.__sim.S.answered};})()`);
  ok('PKT-256 correctly predicted COERCE in lenient mode', /COERCE/.test(afterCoerce.label) && afterCoerce.answered === true, JSON.stringify(afterCoerce));
  await ev(`window.__sim.setMode('strict')`); await sleep(120);
  const afterFlip = await ev(`(function(){var W=window.__sim;return {
    id:W.currentCard().id, answered:W.S.answered, mode:W.mode(),
    strictBtn:document.getElementById('modeStrict').classList.contains('active')};})()`);
  ok('SAME packet still shown after flipping to strict; prediction reset for re-guess', afterFlip.id === 'PKT-256' && afterFlip.answered === false && afterFlip.mode === 'strict' && afterFlip.strictBtn === true, JSON.stringify(afterFlip));
  ok('mode flip is narrated in the boundary log', (await logHas('/mode set to STRICT/')) === true);
  await ev(`window.__sim.pick('reject')`); await sleep(120);
  const flipRevealed = await ev(`(function(){return {label:document.getElementById('vLabel').textContent,
    cls:document.getElementById('vLabel').className};})()`);
  ok('same packet now REJECTs under strict mode — the switch actually changed the verdict', /REJECT/.test(flipRevealed.label) && flipRevealed.cls === 'bad', JSON.stringify(flipRevealed));
  ok('flip re-prediction narrated with the [mode flip] tag', (await logHas('/\\[mode flip\\]/')) === true);
  await ev(`window.__sim.setMode('lenient')`); await sleep(80);

  // ---------- 9. full TRY-THIS predict-first run (fresh page) ----------
  await ev('location.reload()'); await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT step 1 opens with question + chips', pBoot.chips === 2 && /Predict first/.test(pBoot.txt), JSON.stringify(pBoot));
  ok('PREDICT instruction hidden until a prediction is made', !/3 packets correctly/.test(pBoot.txt), pBoot.txt);
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor,tip:!!c.title};})()`);
  ok('PREDICT chips are affordant (pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // tap the WRONG chip (idx 0 — "looks reasonable to a person"; correct is 1)
  await ev(`document.querySelectorAll('#chPredict .chip')[0].click()`); await sleep(80);
  const pAfter = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT tap reveals instruction + names your pick',
    pAfter.chips === 0 && /3 packets correctly/.test(pAfter.txt) && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT pick is logged in the boundary log', (await logHas('/you predicted/')) === true);

  // Step 1: three correct predictions in a row — PKT-201 pass, PKT-212 coerce, PKT-223 reject
  await ev(`window.__sim.pick('pass')`); await sleep(100);
  await ev(`window.__sim.next()`); await sleep(80);
  await ev(`window.__sim.pick('coerce')`); await sleep(100); // PKT-212, coerce trap, correct on first try
  let st = await ev('window.__sim.CH.step');
  ok('coercion trap already caught mid step-1 (flag independent of step ordering)', (await ev('window.__sim.CH.coerceTrapOK')) === true, 'coerceTrapOK');
  await ev(`window.__sim.next()`); await sleep(80);
  await ev(`window.__sim.pick('reject')`); await sleep(120); // PKT-223, correct -> 3rd correct in a row
  st = await ev('window.__sim.CH.step');
  ok('TRY-THIS steps 1+2 auto-detected together (3-in-a-row lands after coercion trap already caught)', st >= 3, 'step=' + st);
  ok('PREDICT wrong pick never blocks; verdict names it and teaches',
    (await logHas('/Not what you predicted.*looks like reasonable data/')) === true);

  // Step 3: flip trap on PKT-267. Predict RIGHT via the hook, walk cards forward to it —
  // answer every card correctly in lenient mode (using each card's known lenient verdict)
  // until the flip-trap card comes up.
  await ev('window.__sim.predict(1)'); // step-3 meta prediction, correct
  let guard = 0;
  while ((await ev('window.__sim.currentCard().id')) !== 'PKT-267' && guard < 12) {
    const actual = await ev(`window.__sim.currentCard().lenient.verdict`);
    await ev(`window.__sim.pick(${JSON.stringify(actual)})`);
    await sleep(70);
    await ev(`window.__sim.next()`);
    await sleep(70);
    guard++;
  }
  ok('walked the deck to PKT-267 (strict-flip trap card)', (await ev('window.__sim.currentCard().id')) === 'PKT-267', 'guard=' + guard);
  await ev(`window.__sim.pick('coerce')`); await sleep(100); // correct in lenient
  ok('PKT-267 correctly predicted COERCE in lenient mode', /COERCE/.test(await ev(`document.getElementById('vLabel').textContent`)));
  ok('flipTrapOK not yet true (only lenient half done)', (await ev('window.__sim.CH.flipTrapOK')) === false);
  await ev(`window.__sim.setMode('strict')`); await sleep(100);
  ok('flipping mode reset PKT-267 for re-prediction', (await ev('window.__sim.S.answered')) === false);
  await ev(`window.__sim.pick('reject')`); await sleep(120); // correct in strict — completes the flip trap
  const doneState = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success'),
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('TRY-THIS step 3 auto-detected (strict-flip trap beaten on both halves)', doneState.step === 4, JSON.stringify(doneState));
  ok('CHALLENGE success banner states the takeaway', doneState.success === true && /Same packet, two different outcomes/.test(doneState.txt), doneState.txt.slice(0, 200));
  const dots = await ev(`['d1','d2','d3'].map(function(i){return document.getElementById(i).className})`);
  ok('all three dots marked done', dots.every(c => /done/.test(c)), JSON.stringify(dots));
  await ev(`window.__sim.setMode('lenient')`); await sleep(60);

  // ---------- 10. trap completion cannot be spoofed ----------
  await ev('location.reload()'); await sleep(600);
  ok('fresh reload: flipTrapOK starts false', (await ev('window.__sim.CH.flipTrapOK')) === false);
  await ev(`window.__sim.pick('pass')`); await sleep(80); // PKT-201 correct, unrelated to any trap
  ok('an unrelated correct prediction does not spoof the flip trap', (await ev('window.__sim.CH.flipTrapOK')) === false);
  ok('an unrelated correct prediction does not spoof the coercion trap either', (await ev('window.__sim.CH.coerceTrapOK')) === false);
  await ev(`window.__sim.next()`); await sleep(80);
  ok('coercion-trap card PKT-212 is on the table', (await ev('window.__sim.currentCard().id')) === 'PKT-212');
  await ev(`window.__sim.pick('reject')`); await sleep(100); // WRONG guess on the actual trap card
  ok('a WRONG guess on the trap card itself does NOT complete the coercion trap', (await ev('window.__sim.CH.coerceTrapOK')) === false);

  // ---------- 11. Reset (R5) ----------
  await ev(`window.__sim.next()`); await sleep(60);
  await ev(`window.__sim.setMode('strict')`); await sleep(60);
  await ev('document.getElementById("reset").click()'); await sleep(600);
  const afterReset = await ev(`(function(){var W=window.__sim;return {
    card:W.currentCard().id, mode:W.mode(), step:W.CH.step, streak:W.S.streak, solved:W.S.retired.size,
    answered:W.S.answered, label:document.getElementById('vLabel').textContent};})()`);
  ok('R5 Reset returns to initial state', afterReset.card === 'PKT-201' && afterReset.mode === 'lenient' && afterReset.step === 1
    && afterReset.streak === 0 && afterReset.solved === 0 && afterReset.answered === false
    && /predict, then reveal/.test(afterReset.label), JSON.stringify(afterReset));

  // ---------- 12. fits the frame (R3) ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @900x560', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @900x560', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 13. prefers-reduced-motion (R4) ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedBad = await ev(`(function(){var bad=0;
    document.querySelectorAll('*').forEach(function(el){var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad++;});
    return bad;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedBad === 0, 'active=' + reducedBad);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m5-validation-boundary-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
