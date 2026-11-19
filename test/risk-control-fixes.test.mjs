import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// These are structural guards, not behavioural tests: the sources are TypeScript and
// this suite runs `node --test` with no build step, so we assert on the tracked source
// text the same way dom-visibility.test.mjs does. Each assertion pins the *root cause*
// of a bug that previously shipped silently, so a regression fails loudly here.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('offscreen document URL matches where the bundler emits the page', () => {
  const manager = read('src/background/offscreen-manager.ts');

  // Regression: the historical value was 'src/offscreen/index.html', which 404s inside
  // the packaged extension. chrome.offscreen.createDocument() then rejects with
  // "Page failed to load." and every sandbox tool dies with a misleading
  // "Could not establish connection" error.
  assert.match(manager, /const OFFSCREEN_URL = 'offscreen\/index\.html';/);
  assert.doesNotMatch(manager, /OFFSCREEN_URL = 'src\//);
});

test('manifest allows WebAssembly compilation and cookie reads', () => {
  const manifest = JSON.parse(read('manifest.json'));

  // Regression: with no content_security_policy, MV3's default CSP blocks
  // WebAssembly.instantiate(). The offscreen module loads fine and only the WASM
  // compile fails, so the QuickJS sandbox silently never works.
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert.match(csp, /'wasm-unsafe-eval'/, 'MV3 needs wasm-unsafe-eval for the QuickJS sandbox');

  // Regression: page_state used chrome.cookies without the permission and swallowed the
  // error, so cookies always came back as [].
  assert.ok(manifest.permissions.includes('cookies'), 'page_state needs the cookies permission');
});

test('offscreen listener answers the caller instead of only broadcasting', () => {
  const offscreen = read('src/offscreen/index.ts');

  // Regression: the listener ran handleMessage() and returned false without ever calling
  // sendResponse, so chrome.runtime.sendMessage() resolved to undefined and tools reported
  // an empty result.
  assert.match(offscreen, /sendResponse\(\s*\{\s*success:\s*true/, 'must reply with success');
  assert.match(offscreen, /sendResponse\(\{[\s\S]{0,120}success:\s*false/, 'must reply with failure');
  assert.match(offscreen, /return true;/, 'must keep the message channel open for async sendResponse');
});

test('VM detector recognises control-flow-flattening state machines', () => {
  const detector = read('src/core/babel/vm-pattern-detector.ts');

  // Regression: every branch was gated on isInfiniteLoopCondition(), so obfuscator.io /
  // javascript-obfuscator output (var s=5; while(s){switch(s){case 48+7-50: ...}}) was
  // reported as "no dispatcher" on files with hundreds of them.
  assert.match(detector, /function matchStateMachineDispatch\(/, 'state-machine predicate missing');
  assert.match(detector, /case 'while-switch-state-machine'|'while-switch-state-machine'/);

  // Arithmetic case labels like `case 48+7-50:` must be folded to numbers.
  assert.match(detector, /function constFold\(/, 'constant folding for case labels missing');
  assert.match(detector, /MAX_FOLD_DEPTH/, 'fold depth must be bounded');

  // The state-machine support must be additive: loosening the generic predicate would
  // change behaviour for every other detector branch.
  assert.match(detector, /function isInfiniteLoopCondition\(/, 'generic predicate must stay');
  assert.doesNotMatch(
    detector,
    /isInfiniteLoopCondition[\s\S]{0,200}?isIdentifier\(node\)\s*\)\s*return true/,
    'isInfiniteLoopCondition must not be widened to accept plain identifiers',
  );
});

test('protection detector knows the China-market WAF and fingerprint vendors', () => {
  const tool = read('src/mcp/tools/detect-protection.ts');

  // Regression: the pattern list only knew Cloudflare/RuiShu/Zhihu, and the tool scanned
  // just the HTML document. Aliyun WAF + TongDun + Aliyun FP pages therefore scored
  // {type:"none", level:1, confidence:0}.
  assert.match(tool, /acw_sc__v2|acw_sc__v\[23\]/, 'Aliyun WAF challenge marker missing');
  assert.match(tool, /trustdevice|_fmOpt|tdCaptcha/i, 'TongDun TrustDevice marker missing');
  assert.match(tool, /aliyunfp|ALIYUN_FP/i, 'Aliyun FP marker missing');

  // Protection SDKs are external <script src> files, so the HTML alone is never enough.
  assert.match(tool, /extractScriptUrls/, 'must parse external script URLs');
  assert.match(tool, /fetchScriptSources/, 'must fetch external scripts before judging');
});
