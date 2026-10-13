// Finds names that are used but never declared (the kind of mistake that only shows up when the app runs).
// Run with: node --expose-internals scripts/lint-undefined.js
let acorn, walk;
try { acorn = require('internal/deps/acorn/acorn/dist/acorn'); walk = require('internal/deps/acorn/acorn-walk/dist/walk'); }
catch { console.log('(skipped: this Node version does not expose its parser)'); process.exit(0); }
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs'), path = require('path');
const G = new Set([...Object.getOwnPropertyNames(globalThis), 'require', 'module', 'exports', '__dirname', '__filename', 'document', 'window', 'navigator', 'localStorage', 'sessionStorage',
  'speechSynthesis', 'SpeechSynthesisUtterance', 'AudioContext', 'AudioWorkletNode', 'MediaRecorder', 'ResizeObserver', 'createImageBitmap', 'Audio', 'Image', 'confirm', 'alert', 'innerWidth', 'innerHeight',
  'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio', 'location', 'getComputedStyle', 'addEventListener', 'HTMLElement', 'Node', 'File', 'FileReader', 'MutationObserver', 'WebSocket', 'Worker',
  'AbortSignal', 'FormData', 'Blob', 'Headers', 'Response', 'Request', 'DOMParser', 'XMLHttpRequest', 'scrollTo', 'scrollY', 'showError', 'performance', 'queueMicrotask', 'structuredClone', 'fetch', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams',
  'AudioBuffer', 'OffscreenCanvas', 'ImageData', 'Event', 'KeyboardEvent', 'WebGLRenderingContext', 'process', 'Buffer', 'globalThis', 'registerProcessor', 'AudioWorkletProcessor', 'sampleRate', 'currentTime', 'IntersectionObserver', 'Notification', 'Intl',
  'NodeFilter', 'MutationObserver', 'getSelection', 'ClipboardEvent', 'DataTransfer', 'CustomEvent', 'requestIdleCallback', 'cancelIdleCallback']);
let bad = 0;
function check(file, module_) {
  const src = fs.readFileSync(file, 'utf8');
  let ast; try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: module_ ? 'module' : 'script', allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }); } catch (e) { console.log(file, 'PARSE', e.message); bad++; return; }
  const decl = new Set(), refs = new Map();
  const pat = (p) => { if (!p) return; if (p.type === 'Identifier') decl.add(p.name); else if (p.type === 'ObjectPattern') p.properties.forEach((x) => pat(x.value || x.argument)); else if (p.type === 'ArrayPattern') p.elements.forEach(pat); else if (p.type === 'RestElement') pat(p.argument); else if (p.type === 'AssignmentPattern') pat(p.left); };
  walk.full(ast, (n) => {
    if (n.type === 'VariableDeclarator') pat(n.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') { if (n.id) decl.add(n.id.name); n.params.forEach(pat); }
    else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') { if (n.id) decl.add(n.id.name); }
    else if (n.type === 'CatchClause') pat(n.param);
    else if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') decl.add(n.local.name);
  });
  walk.simple(ast, { Identifier(n) { if (!refs.has(n.name)) refs.set(n.name, n.start); } });
  for (const [name, at] of refs) if (!decl.has(name) && !G.has(name)) { const line = src.slice(0, at).split('\n').length; console.log(`${file}:${line}  ${name} is not defined`); bad++; }
}
const files = [];
const add = (dir, mod, skip = []) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) { if (!skip.includes(f) && f !== 'node_modules' && f !== 'vendor') add(p, mod, skip); } else if (f.endsWith('.js')) files.push([p, mod]); } };
add('src/main', false); add('scripts', false); add('addons', false); add('src/shared', true); add('src/renderer', true);
for (const [f, m] of files) check(f, m);
console.log(bad ? `${bad} problem(s)` : `checked ${files.length} files: no undefined names`);
process.exit(bad ? 1 : 0);
