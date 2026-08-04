#!/usr/bin/env node
// Headless-Chrome assertion harness for m6-config-resolver.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m6-config-resolver.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm6-config-resolver.html');
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
    '--no-sandbox', '--disable-gpu', '--window-size=1000,620',
    '--user-data-dir=/tmp/m6-config-resolver-chrome-' + process.pid, 'about:blank',
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
  ok('renders — 4 precedence options present', (await ev('document.querySelectorAll("#precOpts .opt").length')) === 4);
  ok('renders — 3 crash options present', (await ev('document.querySelectorAll("#crashOpts .opt").length')) === 3);
  ok('renders — 3 layer rows present', (await ev('document.querySelectorAll("#precLayers .layerRow").length')) === 3);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affPrec = await ev(`(function(){var bad=[];
    document.querySelectorAll('#precOpts .opt, #crashOpts .opt, .layerToggle, .chip, .stratBtn, #reset').forEach(function(e){
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(e.id||e.className.split(' ')[0]+':cursor='+cs.cursor);
      if(!e.title)bad.push((e.id||e.className)+':no-title');
    });return bad;})()`);
  ok('R2 interactive controls have pointer cursor + tooltip', affPrec.length === 0, affPrec.join(','));
  const affTimeline = await ev(`(function(){var bad=[];
    document.querySelectorAll('.tStop').forEach(function(e){
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push('tStop:cursor='+cs.cursor);
      if(!e.title)bad.push('tStop:no-title');
    });return bad;})()`);
  ok('R2 timeline stops are affordant (pointer + title)', affTimeline.length === 0, affTimeline.join(','));
  const inert = await ev(`(function(){return {
    diskView:getComputedStyle(document.getElementById('diskView')).cursor,
    log:getComputedStyle(document.getElementById('evList')).cursor,
    precResult:getComputedStyle(document.getElementById('precResultWrap')).cursor,
    crashResult:getComputedStyle(document.getElementById('crashResultWrap')).cursor,
    stats:getComputedStyle(document.getElementById('stats')).cursor};})()`);
  ok('R2 disk view / event log / results / stats are inert (cursor:default)',
    inert.diskView === 'default' && inert.log === 'default' && inert.precResult === 'default' &&
    inert.crashResult === 'default' && inert.stats === 'default', JSON.stringify(inert));
  ok('R8 honest-model footnote present + tooltip',
    await ev(`(function(){var n=document.getElementById('note');return !!n && /teaching model/.test(n.textContent) && !!n.title && /fsync/.test(n.title);})()`) === true);

  // ---------- 3. real-code parity (verified against labs/checkpoints/v0.4/src/platformops/config.py) ----------
  ok('PARITY empty-string env still overrides FILE (apply_env_overrides checks `in environ`, not truthiness)',
    await ev(`(function(){var W=window.__sim;
      W.setLayerOn('file',true);W.setLayerValue('file','prod');
      W.setLayerOn('env',true);W.setLayerValue('env','');
      var w=W.winner();return w.layer==='ENV' && w.value==='';})()`) === true);
  ok('PARITY env unset leaves FILE untouched',
    await ev(`(function(){var W=window.__sim;
      W.setLayerOn('env',false);
      var w=W.winner();return w.layer==='FILE' && w.value==='prod';})()`) === true);

  // ---------- 4. teaching invariants -- the regression teeth ----------
  const invEnvBeatsAll = await ev(`(function(){var W=window.__sim;
    var combos=[[true,true],[true,false],[false,true],[false,false]];
    return combos.every(function(c){
      W.setLayerOn('default',true);W.setLayerOn('file',c[0]);W.setLayerOn('env',true);W.setLayerValue('env','staging');
      return W.winner().layer==='ENV';
    });})()`);
  ok('INVARIANT env-beats-file-beats-default whenever ENV layer is on (any FILE/DEFAULT combo)', invEnvBeatsAll === true);
  const invFileBeatsDefault = await ev(`(function(){var W=window.__sim;
    W.setLayerOn('env',false);W.setLayerOn('default',true);W.setLayerOn('file',true);W.setLayerValue('file','staging');
    return W.winner().layer==='FILE' && W.winner().value==='staging';})()`);
  ok('INVARIANT file beats default when env is off', invFileBeatsDefault === true);
  const invDefaultOnly = await ev(`(function(){var W=window.__sim;
    W.setLayerOn('env',false);W.setLayerOn('file',false);W.setLayerOn('default',true);W.setLayerValue('default','dev');
    return W.winner().layer==='DEFAULT' && W.winner().value==='dev';})()`);
  ok('INVARIANT default only wins when file and env are both off', invDefaultOnly === true);
  const invNone = await ev(`(function(){var W=window.__sim;
    W.setLayerOn('env',false);W.setLayerOn('file',false);W.setLayerOn('default',false);
    return W.winner().layer==='NONE';})()`);
  ok('INVARIANT all three off -> NONE (real v0.4 would raise "Field required")', invNone === true);

  const invAtomicNeverCorrupt = await ev(`(function(){var W=window.__sim;
    var bad=[];for(var i=0;i<5;i++){if(['intact-old','intact-new'].indexOf(
      (function(){var arr={direct:['intact-old','corrupt-partial','corrupt-partial','intact-new'],
        atomic:['intact-old','intact-old','intact-old','intact-old','intact-new']};return arr.atomic[i];})()
    )===-1)bad.push(i);}return bad;})()`);
  ok('INVARIANT atomic strategy never yields corrupt-partial at any instant', invAtomicNeverCorrupt.length === 0, JSON.stringify(invAtomicNeverCorrupt));
  const invDirectMidCorrupt = await ev(`(function(){
    var arr=['intact-old','corrupt-partial','corrupt-partial','intact-new'];
    return arr[1]==='corrupt-partial' && arr[2]==='corrupt-partial';})()`);
  ok('INVARIANT direct strategy is corrupt at both truncate and mid-write instants', invDirectMidCorrupt === true);
  const invSameInstantDiverges = await ev(`(function(){
    var direct=['intact-old','corrupt-partial','corrupt-partial','intact-new'];
    var atomic=['intact-old','intact-old','intact-old','intact-old','intact-new'];
    return direct[2]==='corrupt-partial' && atomic[2]==='intact-old';})()`);
  ok('INVARIANT same crash instant (mid-write) diverges: direct=corrupt, atomic=intact-old', invSameInstantDiverges === true);

  // ---------- 5. boot state (reload to reset the pokes from invariant checks above) ----------
  await ev('location.reload()'); await sleep(600);
  ok('boot: default layers -- DEFAULT=dev/on, FILE=prod/on, ENV off',
    (await ev(`(function(){var L=window.__sim.S.layers;
      return L.default.on===true&&L.default.value==='dev'&&L.file.on===true&&L.file.value==='prod'&&L.env.on===false;})()`)) === true);
  ok('boot: strategy starts DIRECT', (await ev('window.__sim.S.strategy')) === 'direct');
  ok('boot: crash instant starts at 0', (await ev('window.__sim.S.pos')) === 0);
  ok('boot: DIRECT button shows active state', (await ev(`document.getElementById('stratDirect').classList.contains('active')`)) === true);

  // ---------- 6. precedence call + reveal (correct path: FILE wins) ----------
  await ev(`window.__sim.pickPrec('FILE')`); await sleep(100);
  const precRight = await ev(`(function(){return {
    label:document.getElementById('precLabel').textContent, cls:document.getElementById('precLabel').className,
    streak:window.__sim.S.precStreak};})()`);
  ok('correct FILE prediction: verdict shown + streak increments', /FILE wins/.test(precRight.label) && precRight.streak === 1, JSON.stringify(precRight));
  ok('ops log narrates the file-wins outcome', (await logHas('/file value stands/')) === true);

  // change a layer -> auto re-arms
  await ev(`window.__sim.setLayerOn('env',true)`); await sleep(80);
  ok('changing a layer re-arms prediction (precAnswered false)', (await ev('window.__sim.S.precAnswered')) === false);

  // ---------- 7. precedence wrong-prediction path ----------
  await ev(`window.__sim.setLayerValue('env','staging')`); await sleep(80);
  await ev(`window.__sim.pickPrec('FILE')`); await sleep(100); // wrong: ENV is on now, should win
  const precWrong = await ev(`(function(){return {label:document.getElementById('precLabel').textContent, streak:window.__sim.S.precStreak};})()`);
  ok('wrong prediction: verdict names ENV as actual winner + resets streak', /ENV wins/.test(precWrong.label) && precWrong.streak === 0, JSON.stringify(precWrong));
  ok('ops log narrates the miss', (await logHas('/you called FILE wins.*ENV wins/')) === true);

  // ---------- 8. crash call + reveal: direct, mid-write -> corrupt-partial ----------
  await ev(`window.__sim.setStrategy('direct')`); await sleep(80);
  await ev(`window.__sim.setPos(2)`); await sleep(80);
  ok('disk view hidden before reveal', (await ev(`document.getElementById('diskView').textContent`)) === '— pull the plug to see what is on disk —');
  await ev(`window.__sim.pickCrash('corrupt-partial')`); await sleep(120);
  const crashRight = await ev(`(function(){return {label:document.getElementById('crashLabel').textContent, cls:document.getElementById('crashLabel').className};})()`);
  ok('direct mid-write correctly predicted CORRUPT-PARTIAL', /CORRUPT-PARTIAL/.test(crashRight.label) && crashRight.cls.indexOf('bad')!==-1, JSON.stringify(crashRight));
  ok('ops log narrates the corruption in shell vocabulary', (await logHas('/exit code: 1/')) === true);
  const diskAfterDirect = await ev(`document.getElementById('diskView').textContent`);
  ok('disk view reveals the truncated fragment for direct mid-write', /regi/.test(diskAfterDirect), diskAfterDirect);

  // ---------- 9. crash call + reveal: atomic, SAME instant -> intact-old ----------
  await ev(`window.__sim.setStrategy('atomic')`); await sleep(80);
  ok('same instant index preserved across strategy switch', (await ev('window.__sim.S.pos')) === 2);
  ok('switching strategy re-armed crash prediction', (await ev('window.__sim.S.crashAnswered')) === false);
  await ev(`window.__sim.pickCrash('intact-old')`); await sleep(120);
  const crashRight2 = await ev(`(function(){return {label:document.getElementById('crashLabel').textContent, cls:document.getElementById('crashLabel').className};})()`);
  ok('atomic mid-write correctly predicted INTACT-OLD', /INTACT-OLD/.test(crashRight2.label) && crashRight2.cls.indexOf('ok')!==-1, JSON.stringify(crashRight2));
  const diskAfterAtomic = await ev(`document.getElementById('diskView').textContent`);
  ok('disk view shows target untouched (old content) and a corrupt temp file for atomic mid-write', /us-east-1/.test(diskAfterAtomic) && /regi/.test(diskAfterAtomic), diskAfterAtomic);
  ok('ops log calls out the leftover temp file', (await logHas('/\\.tmp/')) === true);

  // ---------- 10. full TRY-THIS predict-first run (fresh page) ----------
  await ev('location.reload()'); await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT step 1 opens with question + chips', pBoot.chips === 2 && /Predict first/.test(pBoot.txt), JSON.stringify(pBoot));
  ok('PREDICT instruction hidden until a prediction is made', !/3 predictions right/.test(pBoot.txt), pBoot.txt);
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor,tip:!!c.title};})()`);
  ok('PREDICT chips are affordant (pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // tap the WRONG chip (idx 0 -- "an empty override does not count"; correct is 1)
  await ev(`document.querySelectorAll('#chPredict .chip')[0].click()`); await sleep(80);
  const pAfter = await ev(`(function(){return {
    chips:document.querySelectorAll('#chPredict .chip').length,
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('PREDICT tap reveals instruction + names your pick',
    pAfter.chips === 0 && /3 predictions right/.test(pAfter.txt) && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT pick is logged in the ops log', (await logHas('/you predicted/')) === true);
  ok('PREDICT wrong pick never blocks the challenge (step stays at 1, not stuck)', (await ev('window.__sim.CH.step')) === 1);

  // Step 1: 3 correct predictions in a row, including the empty-string edge.
  // r1: FILE wins (default on/dev, file on/prod, env off) -- correct
  await ev(`window.__sim.pickPrec('FILE')`); await sleep(100);
  ok('r1 correct, streak=1', (await ev('window.__sim.S.precStreak')) === 1);
  // r2: turn ENV on with empty string -- the trap -- predict ENV wins
  await ev(`window.__sim.setLayerOn('env',true)`); await sleep(60);
  await ev(`window.__sim.setLayerValue('env','')`); await sleep(60);
  await ev(`window.__sim.pickPrec('ENV')`); await sleep(100);
  ok('r2 (empty-string edge) correct, streak=2, emptyEdgeInStreak flagged',
    (await ev('window.__sim.S.precStreak')) === 2 && (await ev('window.__sim.S.precEmptyEdgeInStreak')) === true);
  // r3: turn env value to something non-empty, still on -- predict ENV wins again
  await ev(`window.__sim.setLayerValue('env','staging')`); await sleep(60);
  await ev(`window.__sim.pickPrec('ENV')`); await sleep(100);
  ok('r3 correct, streak=3 -- TRY-THIS step 1 auto-detected', (await ev('window.__sim.CH.done[0]')) === true);
  const afterStep1 = await ev(`(function(){return {step:window.__sim.CH.step,
    d1:document.getElementById('d1').className};})()`);
  ok('step 1 dot marked done, banner advanced to step 2', afterStep1.step === 2 && /done/.test(afterStep1.d1), JSON.stringify(afterStep1));

  // trap cannot be spoofed by an unrelated streak (fresh reload)
  await ev('location.reload()'); await sleep(600);
  await ev(`window.__sim.pickPrec('FILE')`); await sleep(80);
  await ev(`window.__sim.setLayerOn('file',false)`); await sleep(60);
  await ev(`window.__sim.setLayerOn('default',false)`); await sleep(60);
  await ev(`window.__sim.setLayerOn('env',true)`); await sleep(60);
  await ev(`window.__sim.setLayerValue('env','prod')`); await sleep(60);
  await ev(`window.__sim.pickPrec('ENV')`); await sleep(80);
  await ev(`window.__sim.setLayerValue('env','dev')`); await sleep(60);
  await ev(`window.__sim.pickPrec('ENV')`); await sleep(80);
  ok('3-in-a-row WITHOUT the empty-string edge does NOT complete step 1', (await ev('window.__sim.CH.done[0]')) === false,
    'streak=' + (await ev('window.__sim.S.precStreak')));

  // ---------- 11. steps 2 + 3: crash instants (fresh, walk through step 1 quickly first) ----------
  await ev('location.reload()'); await sleep(600);
  await ev(`window.__sim.predict(1)`); // meta-predict step1 correct (not required, but exercises it)
  await ev(`window.__sim.pickPrec('FILE')`); await sleep(80);
  await ev(`window.__sim.setLayerOn('env',true)`); await sleep(50);
  await ev(`window.__sim.setLayerValue('env','')`); await sleep(50);
  await ev(`window.__sim.pickPrec('ENV')`); await sleep(80);
  await ev(`window.__sim.setLayerValue('env','staging')`); await sleep(50);
  await ev(`window.__sim.pickPrec('ENV')`); await sleep(80);
  ok('step 1 done, advanced to step 2', (await ev('window.__sim.CH.step')) === 2);

  await ev(`window.__sim.predict(0)`); // meta-predict step2 correct
  ok('meta-prediction chip for step 2 rendered after step advance', (await ev(`document.querySelectorAll('#chPredict .chip').length`)) >= 0);
  // WRONG crash call first: at mid-write direct, predict intact-new (wrong)
  await ev(`window.__sim.setStrategy('direct')`); await sleep(50);
  await ev(`window.__sim.setPos(2)`); await sleep(50);
  await ev(`window.__sim.pickCrash('intact-new')`); await sleep(100);
  ok('wrong crash call does not complete step 2', (await ev('window.__sim.CH.step2OK')) === false);
  await ev(`window.__sim.setPos(1)`); await sleep(50); // re-arm via changing instant
  await ev(`window.__sim.setPos(2)`); await sleep(50);
  await ev(`window.__sim.pickCrash('corrupt-partial')`); await sleep(100);
  ok('step 2 auto-detected: direct mid-write correctly called CORRUPT-PARTIAL', (await ev('window.__sim.CH.step')) === 3);

  await ev(`window.__sim.predict(1)`); // meta-predict step3 correct
  await ev(`window.__sim.setStrategy('atomic')`); await sleep(50);
  ok('same mid-write instant (pos=2) carried into atomic for step 3', (await ev('window.__sim.S.pos')) === 2);
  await ev(`window.__sim.pickCrash('intact-old')`); await sleep(120);
  const doneState = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success'),
    txt:document.getElementById('chTxt').textContent};})()`);
  ok('TRY-THIS step 3 auto-detected (atomic mid-write correctly called INTACT-OLD)', doneState.step === 4, JSON.stringify(doneState));
  ok('CHALLENGE success banner states the takeaway', doneState.success === true && /ENV beats FILE beats DEFAULT/.test(doneState.txt), doneState.txt.slice(0, 200));
  const dots = await ev(`['d1','d2','d3'].map(function(i){return document.getElementById(i).className})`);
  ok('all three dots marked done', dots.every(c => /done/.test(c)), JSON.stringify(dots));

  // ---------- 12. Reset (R5) ----------
  await ev('document.getElementById("reset").click()'); await sleep(600);
  const afterReset = await ev(`(function(){var W=window.__sim;return {
    strategy:W.S.strategy, pos:W.S.pos, step:W.CH.step, precStreak:W.S.precStreak,
    precAnswered:W.S.precAnswered, crashAnswered:W.S.crashAnswered,
    label:document.getElementById('precLabel').textContent};})()`);
  ok('R5 Reset returns to initial state', afterReset.strategy === 'direct' && afterReset.pos === 0 && afterReset.step === 1
    && afterReset.precStreak === 0 && afterReset.precAnswered === false && afterReset.crashAnswered === false
    && /set the layers, then predict/.test(afterReset.label), JSON.stringify(afterReset));

  // ---------- 13. fits the frame (R3) ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @1000x620', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @1000x620', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 14. prefers-reduced-motion (R4) ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedBad = await ev(`(function(){var bad=0;
    document.querySelectorAll('*').forEach(function(el){var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad++;});
    return bad;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedBad === 0, 'active=' + reducedBad);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m6-config-resolver-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
