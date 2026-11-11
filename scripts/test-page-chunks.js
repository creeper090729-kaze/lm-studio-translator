'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console: console };
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8'),
  sandbox
);
const LM = sandbox.LMShared;

function text(value) {
  return { nodeType: 3, nodeValue: value };
}
function el(tag, children) {
  return { nodeType: 1, tagName: tag, childNodes: children || [] };
}
function pullAll(root, limit, skip) {
  const walker = LM.createPageWalker(root, { pre: false, skip: skip || function () { return false; } });
  const out = [];
  let piece = walker.pull(limit);
  while (piece) {
    if (piece.length > limit) throw new Error('piece longer than limit: ' + piece.length);
    out.push(piece);
    piece = walker.pull(limit);
  }
  return out;
}

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed += 1;
    console.error('FAIL ' + name);
  }
}

check('letters', LM.meaningfulText('你好') && LM.meaningfulText('A') && !LM.meaningfulText('……') && !LM.meaningfulText('12'));

const split = pullAll(el('DIV', [text('你好'), el('BR'), text('世界')]), 2000);
check('br splits paragraphs', split.length === 2 && split[0] === '你好' && split[1] === '世界');

const ruby = pullAll(el('P', [
  text('漢'),
  el('RT', [text('かん')]),
  text('字')
]), 2000, function (node) { return node.tagName === 'RT'; });
check('skip ruby reading', ruby.length === 1 && ruby[0] === '漢字');

let huge = '';
for (let i = 0; i < 9000; i += 1) huge += '字';
const parts = pullAll(el('DIV', [text(huge)]), 2000);
check('long text stays chunked', parts.length === 5 && parts.join('') === huge && parts[0].length === 2000 && parts[4].length === 1000);

const sentenced = '甲乙丙丁戊己庚辛壬癸。' + '子丑寅卯辰巳午未申酉。';
const cut = pullAll(el('DIV', [text(sentenced)]), 12);
check('sentence boundary', cut[0] === '甲乙丙丁戊己庚辛壬癸。' && cut.join('') === sentenced);

const paras = [];
const children = [];
for (let i = 0; i < 40; i += 1) {
  const line = '第' + i + '段甲乙丙丁。';
  paras.push(line);
  if (i) children.push(el('BR'));
  children.push(text(line));
}
check('many paragraphs stay separate', pullAll(el('DIV', children), 2000).join('\n') === paras.join('\n'));

const preWalker = LM.createPageWalker(el('PRE', [text('甲\n乙丙')]), { pre: true });
check('pre lines', preWalker.pull(2000) === '甲' && preWalker.pull(2000) === '乙丙' && preWalker.pull(2000) === null);

const skipped = pullAll(el('DIV', [
  text('留'),
  el('SCRIPT', [text('秘密')]),
  text('下')
]), 2000, function (node) { return node.tagName === 'SCRIPT'; });
check('skip subtree', skipped.length === 1 && skipped[0] === '留下');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('ok');
