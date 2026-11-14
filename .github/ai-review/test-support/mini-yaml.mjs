// 테스트 전용: GitHub Actions 워크플로를 읽기 위한 최소 YAML 파서.
// 지원: 블록 맵·블록 리스트, `|`/`>` 블록 스칼라, `[a, b]`·`{}` 흐름 표기, 따옴표, 주석.
// 앵커·별칭·여러 문서·복잡한 흐름 표기는 지원하지 않는다(워크플로에 쓰지 않는다).

export function parseYaml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  const indentOf = (l) => l.match(/^ */)[0].length;
  const isSkippable = (l) => l.trim() === '' || l.trim().startsWith('#');
  const skip = () => { while (i < lines.length && isSkippable(lines[i])) i++; };
  const fail = (msg) => { throw new Error(`mini-yaml ${i + 1}행: ${msg}: ${lines[i]}`); };
  const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s'"#\-[{][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

  function node() {
    skip();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    const c = lines[i].trim();
    return c === '-' || c.startsWith('- ') ? seq(ind) : map(ind);
  }

  function map(ind) {
    const obj = {};
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== ind) break;
      const c = stripComment(lines[i].slice(ind));
      if (c === '-' || c.startsWith('- ')) break;
      const m = c.match(KEY);
      if (!m) fail('키를 읽을 수 없음');
      i++;
      obj[unquote(m[1])] = value((m[2] ?? '').trim(), ind);
    }
    return obj;
  }

  function value(rest, ind) {
    if (rest === '') {
      skip();
      if (i >= lines.length) return null;
      const ni = indentOf(lines[i]);
      const nc = lines[i].trim();
      if (ni > ind || (ni === ind && (nc === '-' || nc.startsWith('- ')))) return node();
      return null;
    }
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(ind);
    return scalar(rest);
  }

  function blockScalar(ind) {
    const out = [];
    let base = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { out.push(''); i++; continue; }
      const li = indentOf(l);
      if (li <= ind) break;
      if (base === null) base = li;
      out.push(l.slice(Math.min(base, li)));
      i++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n') + '\n';
  }

  function seq(ind) {
    const arr = [];
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== ind) break;
      const c = stripComment(lines[i].slice(ind));
      if (!(c === '-' || c.startsWith('- '))) break;
      const after = c === '-' ? '' : c.slice(2);
      const item = after.trim();
      if (item === '') { i++; arr.push(node()); continue; }
      if (KEY.test(item) && !/^[[{"']/.test(item)) {
        const keyIndent = ind + 2 + (after.length - after.trimStart().length);
        lines[i] = ' '.repeat(keyIndent) + item;
        arr.push(map(keyIndent));
      } else {
        i++;
        arr.push(scalar(item));
      }
    }
    return arr;
  }

  const result = node();
  skip();
  if (i < lines.length) fail('읽지 못한 줄이 남음');
  return result;
}

function stripComment(s) {
  let quote = null;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    const prev = k === 0 ? ' ' : s[k - 1];
    if (quote) {
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && /[\s:[,{]/.test(prev)) {
      quote = ch;
    } else if (ch === '#' && /\s/.test(prev)) {
      return s.slice(0, k).trimEnd();
    }
  }
  return s.trimEnd();
}

function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function scalar(raw) {
  const s = stripComment(raw).trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x.trim()));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (inner === '') return obj;
    for (const part of inner.split(',')) {
      const idx = part.indexOf(':');
      obj[unquote(part.slice(0, idx).trim())] = scalar(part.slice(idx + 1).trim());
    }
    return obj;
  }
  if (/^["']/.test(s)) return unquote(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
