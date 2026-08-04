#!/usr/bin/env node
// Headless-Chrome assertion harness for m7-traceback-detective.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m7-traceback-detective.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm7-traceback-detective.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9200 + (process.pid % 400);

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
    '--no-sandbox', '--disable-gpu', '--window-size=1000,620',
    '--user-data-dir=/tmp/m7-traceback-detective-chrome-' + process.pid, 'about:blank',
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
    { width: 1000, height: 620, deviceScaleFactor: 1, mobile: false });
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
  ok('renders — 8 tickets in queue', (await ev('document.querySelectorAll("#queueList .ticket").length')) === 8);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');
  ok('8 cases in data model', (await ev('window.__sim.CASES.length')) === 8);

  // ---------- 2. affordance sanity (R2) ----------
  await ev(`window.__sim.openCase('c1')`); await sleep(100);
  const affClick = await ev(`(function(){var bad=[];
    document.querySelectorAll('.ticket, #reset, .frameRow.clickable, .qChip:not(:disabled)').forEach(function(e){
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push((e.className||e.id)+':cursor='+cs.cursor);
      if(!e.title)bad.push((e.className||e.id)+':no-title');
    });return bad;})()`);
  ok('R2 interactive controls have pointer cursor + tooltip', affClick.length === 0, affClick.join(','));
  const inert = await ev(`(function(){return {
    evList:getComputedStyle(document.getElementById('evList')).cursor,
    stats:getComputedStyle(document.getElementById('stats')).cursor,
    cmdLine:getComputedStyle(document.getElementById('cmdLine')).cursor,
    errorLine:getComputedStyle(document.getElementById('errorLine')).cursor};})()`);
  ok('R2 log / stats / cmd-line / error-line are inert (cursor:default)',
    inert.evList === 'default' && inert.stats === 'default' && inert.cmdLine === 'default' && inert.errorLine === 'default',
    JSON.stringify(inert));
  ok('R8 honest-model footnote present + tooltip',
    await ev(`(function(){var n=document.getElementById('note');return !!n && /teaching model/.test(n.textContent) && !!n.title && /captured/.test(n.title);})()`) === true);

  // ---------- 3. real captured tracebacks — verbatim text checks against known-good output ----------
  const c1Err = await ev(`window.__sim.caseById('c1').error`);
  ok('INVARIANT c1 error text is the real captured KeyError', c1Err === "KeyError: 'alert_channel'", c1Err);
  const c2Err = await ev(`window.__sim.caseById('c2').error`);
  ok('INVARIANT c2 error text includes real captured PyYAML ScannerError', /mapping values are not allowed here/.test(c2Err) && /column 8/.test(c2Err), c2Err);
  const c2LibFrames = await ev(`window.__sim.caseById('c2').blocks[0].frames.filter(function(f){return f.lib}).length`);
  ok('INVARIANT c2 has real multi-frame PyYAML library stack (>=10 library frames)', c2LibFrames >= 10, String(c2LibFrames));
  const c3Chained = await ev(`(function(){var c=window.__sim.caseById('c3');return c.chained && c.blocks.length===2 && /ValueError/.test(c.blocks[0].error) && c.error==='ConfigError: port must be numeric';})()`);
  ok('INVARIANT c3 is a real two-block chained exception (ValueError -> ConfigError)', c3Chained === true);
  const c4Err = await ev(`window.__sim.caseById('c4').error`);
  ok('INVARIANT c4 error text is the real captured UnboundLocalError', /UnboundLocalError.*thresholds.*not associated with a value/.test(c4Err), c4Err);
  const c8Err = await ev(`window.__sim.caseById('c8').error`);
  ok('INVARIANT c8 error text is the real captured stdlib json TypeError', c8Err === 'TypeError: Object of type datetime is not JSON serializable', c8Err);

  // ---------- 4. silent card (c5) has NO traceback element (the trap) ----------
  await ev(`window.__sim.openCase('c5')`); await sleep(100);
  const c5Shape = await ev(`(function(){return {
    frameRows:document.querySelectorAll('.frameRow').length,
    noTb:!!document.getElementById('noTb'),
    errorLine:document.getElementById('errorLine').textContent,
    exitCode:window.__sim.caseById('c5').exitCode,
    stdout:window.__sim.caseById('c5').stdout};})()`);
  ok('INVARIANT c5 silent-failure card has zero frame rows (no traceback at all)', c5Shape.frameRows === 0, JSON.stringify(c5Shape));
  ok('INVARIANT c5 shows the real captured "OK" / exit 0 output, no error line', c5Shape.noTb === true && c5Shape.errorLine === '' && c5Shape.stdout === 'OK' && c5Shape.exitCode === 0, JSON.stringify(c5Shape));

  // ---------- 4b. silent-failure trap: a wrong pick is formative, not blocking ----------
  await ev(`window.__sim.pickTrap(0)`); await sleep(80); // WRONG — "no bug"
  const c5WrongTrap = await ev(`window.__sim.S.cases.c5`);
  ok('trap wrong pick does not solve the case, and does not throw', c5WrongTrap.solved === false && c5WrongTrap.q1 === '0');

  // ---------- 5. clicking a library frame yields the teaching message ----------
  await ev(`window.__sim.openCase('c2')`); await sleep(100);
  await ev(`window.__sim.clickFrameByKey('c2','b0f5')`); await sleep(100); // a library frame, not the crash frame
  ok('library frame click logs the library teaching message', (await logHas('/library code.*not something you maintain/')) === true);
  const c2q1 = await ev(`window.__sim.S.cases.c2.q1`);
  ok('picking a non-crash frame does not silently mark it correct', c2q1 === 'b0f5' && (await ev(`window.__sim.S.cases.c2.q1ok`)) === false);

  // fresh case: the actual crash frame IS a library frame — clicking it correctly should ALSO fire the library message
  await ev(`window.__sim.openCase('c8')`); await sleep(100);
  await ev(`window.__sim.clickFrameByKey('c8','b0f6')`); await sleep(100); // json/encoder.py:180 default — the real crash frame, and library
  const c8q1ok = await ev(`window.__sim.S.cases.c8.q1ok`);
  ok('c8 crash frame is correctly identified even though it is a library frame', c8q1ok === true);
  ok('library frame teaching message also fires on a CORRECT library-frame pick', (await logHas('/library code.*not something you maintain/')) === true);

  // ---------- 6. full case flow: control case where crash frame == guilty frame (c7) ----------
  await ev(`window.__sim.openCase('c7')`); await sleep(100);
  await ev(`window.__sim.clickFrameByKey('c7','b0f2')`); await sleep(80); // region_for_env — correct crash frame
  await ev(`window.__sim.pickCategory(1)`); await sleep(80); // Runtime error
  await ev(`window.__sim.pickFix(0)`); await sleep(100); // region_for_env — correct fix location too
  const c7 = await ev(`window.__sim.S.cases.c7`);
  ok('c7 (control case): crash frame and fix frame are the SAME function, and case solves clean', c7.q1ok === true && c7.solved === true, JSON.stringify(c7));

  // ---------- 6b. chained card: picking the already-handled first exception is wrong, with the chaining explanation ----------
  await ev(`window.__sim.openCase('c3')`); await sleep(80);
  const c3Divider0 = await ev(`document.querySelector('.tbDivider') ? document.querySelector('.tbDivider').textContent : null`);
  ok('chained card renders the "During handling..." divider between two blocks', /During handling of the above exception/.test(c3Divider0 || ''), String(c3Divider0));
  await ev(`window.__sim.clickFrameByKey('c3','b0f0')`); await sleep(80); // ValueError frame — already handled, wrong pick
  const c3WrongPick = await ev(`(function(){return {ok:window.__sim.S.cases.c3.q1ok, explain:document.getElementById('q1Explain').textContent};})()`);
  ok('picking the FIRST (already-handled) exception frame is marked wrong with the chaining explanation',
    c3WrongPick.ok === false && /already handled|caught that one/.test(c3WrongPick.explain), JSON.stringify(c3WrongPick));

  // ---------- 7. AttributeError-on-None case: guilty function never appears as a frame (c6) ----------
  const c6FuncNames = await ev(`window.__sim.caseById('c6').blocks[0].frames.map(function(f){return f.func})`);
  ok('INVARIANT c6 traceback never contains find_owner_team (it returned None, never raised)', c6FuncNames.indexOf('find_owner_team') === -1, JSON.stringify(c6FuncNames));

  // ---------- 8. Q3 data integrity across all 8 cases: exactly one correct fix option ----------
  const q3Integrity = await ev(`(function(){var bad=[];
    window.__sim.CASES.forEach(function(c){
      var opts = c.q3.opts;
      var n = opts.filter(function(o){return o.ok}).length;
      if(opts.length!==3 || n!==1) bad.push(c.id+':n='+n+',len='+opts.length);
    });
    return bad;})()`);
  ok('INVARIANT every case has exactly 3 fix options with exactly 1 correct', q3Integrity.length === 0, JSON.stringify(q3Integrity));

  // ---------- 9. Reset (R5) ----------
  await ev('document.getElementById("reset").click()'); await sleep(600);
  const afterReset = await ev(`(function(){var W=window.__sim;return {
    active:W.S.active, streak:W.S.streak, solved:W.S.solved, step:W.CH.step,
    emptyVisible: document.getElementById('caseEmpty').style.display !== 'none'};})()`);
  ok('R5 Reset returns to initial state', afterReset.active === null && afterReset.streak === 0 && afterReset.solved === 0
    && afterReset.step === 1 && afterReset.emptyVisible === true, JSON.stringify(afterReset));

  // ---------- 10. fits the frame (R3) ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @1000x620', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @1000x620', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 11. prefers-reduced-motion (R4) ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedBad = await ev(`(function(){var bad=0;
    document.querySelectorAll('*').forEach(function(el){var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad++;});
    return bad;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedBad === 0, 'active=' + reducedBad);

  // ---------- 12. full TRY-THIS predict-first challenge run (fresh page) ----------
  await ev('location.reload()'); await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT step 1 opens with question + 2 chips', pBoot.chips === 2 && /Predict first/.test(pBoot.txt), JSON.stringify(pBoot));
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor,tip:!!c.title};})()`);
  ok('PREDICT chips are affordant (pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // tap the WRONG chip first (idx 0 — "crash frame is always the guilty one")
  await ev(`document.querySelectorAll('#chPredict .chip')[0].click()`); await sleep(80);
  const pAfter = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT tap reveals instruction + names your pick', pAfter.chips === 0 && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT wrong pick never blocks the challenge (step stays at 1)', (await ev('window.__sim.CH.step')) === 1);

  // Step 1: 3 correct frame picks in a row across three different tickets.
  await ev(`window.__sim.openCase('c1')`); await sleep(60);
  await ev(`window.__sim.clickFrameByKey('c1','b0f3')`); await sleep(80); // format_alert_channel — correct
  ok('r1 correct, streak=1', (await ev('window.__sim.S.streak')) === 1);
  await ev(`window.__sim.openCase('c4')`); await sleep(60);
  await ev(`window.__sim.clickFrameByKey('c4','b0f3')`); await sleep(80); // load_thresholds return — correct
  ok('r2 correct, streak=2', (await ev('window.__sim.S.streak')) === 2);
  await ev(`window.__sim.openCase('c6')`); await sleep(60);
  await ev(`window.__sim.clickFrameByKey('c6','b0f2')`); await sleep(80); // notify — correct
  ok('r3 correct, streak=3 — TRY-THIS step 1 auto-detected', (await ev('window.__sim.CH.done[0]')) === true);
  const afterStep1 = await ev(`(function(){return {step:window.__sim.CH.step, d1:document.getElementById('d1').className};})()`);
  ok('step 1 dot marked done, banner advanced to step 2', afterStep1.step === 2 && /done/.test(afterStep1.d1), JSON.stringify(afterStep1));

  // a wrong pick resets the streak and does not spoof completion
  await ev(`window.__sim.openCase('c7')`); await sleep(60);
  await ev(`window.__sim.clickFrameByKey('c7','b0f1')`); await sleep(80); // main() — wrong, region_for_env is correct
  ok('wrong frame pick resets streak to 0', (await ev('window.__sim.S.streak')) === 0);

  // Step 2: the chained-exception card, INC-2203, all three sub-questions correct.
  await ev(`window.__sim.openCase('c3')`); await sleep(80);
  const c3Divider = await ev(`document.querySelector('.tbDivider') ? document.querySelector('.tbDivider').textContent : null`);
  ok('chained card renders the "During handling..." divider between two blocks', /During handling of the above exception/.test(c3Divider || ''), String(c3Divider));
  await ev(`window.__sim.clickFrameByKey('c3','b1f2')`); await sleep(80); // raise ConfigError — correct, the uncaught one
  await ev(`window.__sim.pickCategory(1)`); await sleep(60); // Runtime error
  await ev(`window.__sim.pickFix(1)`); await sleep(100); // validate upstream + from exc — correct
  ok('TRY-THIS step 2 auto-detected: chained case (c3) solved clean', (await ev('window.__sim.CH.step')) === 3);

  // Step 3: the silent-failure trap, INC-2205.
  await ev(`window.__sim.openCase('c5')`); await sleep(80);
  const c5Trap = await ev(`document.getElementById('q1Prompt').textContent`);
  ok('silent card poses the no-traceback trap question', /exited 0/.test(c5Trap) || /still a bug/.test(c5Trap), c5Trap);
  await ev(`window.__sim.pickTrap(1)`); await sleep(60); // correct — yes, a real bug got through
  await ev(`window.__sim.pickCategory(2)`); await sleep(60); // Logic error
  await ev(`window.__sim.pickFix(1)`); await sleep(100); // validate_replica_count — correct
  const doneState = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success'),
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('TRY-THIS step 3 auto-detected (silent trap correctly called + case solved)', doneState.step === 4, JSON.stringify(doneState));
  ok('CHALLENGE success banner states the takeaway', doneState.success === true && /clean exit/.test(doneState.txt), doneState.txt.slice(0, 220));
  const dots = await ev(`['d1','d2','d3'].map(function(i){return document.getElementById(i).className})`);
  ok('all three dots marked done', dots.every(c => /done/.test(c)), JSON.stringify(dots));

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m7-traceback-detective-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
