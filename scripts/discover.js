#!/usr/bin/env node
/*
 * askberg discover — the deterministic half of the skill.
 *
 * Harvests "decisions waiting for a human" from a repo and emits candidates.
 * The agent then GRADES these into the questions schema (drops non-gates, writes
 * the recommended default, clusters by project). discover.js finds; the model judges.
 *
 * Usage:
 *   node discover.js [path]        scan a repo (default: cwd) → .askberg/candidates.json
 *   node discover.js --json        print candidates as JSON to stdout
 *   node discover.js --stats       print a per-collector count summary
 *   node discover.js --resolve <file> <line>   strike an answered marker (close the loop)
 *   node discover.js --help
 *
 * Config: .askberg.yml in the repo root (all keys optional). See .askberg.example.yml.
 * Zero dependencies. Node 14+.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DEFAULTS = {
  markers: ['askberg:', 'DECISION:', '@decision', 'BLOCKED:', 'TODO(decide)'],
  docPaths: ['.planning', 'TODO.md', 'DECISIONS.md', 'docs/adr'],
  owner: '@me',
  outDir: '.planning/decisions',
  cleanupDays: 14,
};
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.askberg', 'dist', 'build', 'vendor', 'out', '.next', 'coverage', '.venv']);
const DOC_SIGNALS = /(^|\W)(pending|blocked|open question|awaiting|needs? decision|decision needed|waiting on|to decide|unresolved|\bTBD\b|@decision)(\W|$)/i;
const MAX_BYTES = 512 * 1024;

// ---- tiny YAML-subset parser (lists of scalars + scalars; enough for our config) ----
function loadConfig(root) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const file = ['.askberg.yml', '.askberg.yaml'].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  if (!file) return cfg;
  let key = null;
  for (let raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^(\w+):\s*$/))) { key = m[1]; if (Array.isArray(DEFAULTS[key])) cfg[key] = []; continue; }
    if ((m = line.match(/^\s*-\s*(.+?)\s*$/)) && key) { cfg[key].push(unquote(m[1])); continue; }
    if ((m = line.match(/^(\w+):\s*(.+?)\s*$/))) { key = null; const v = unquote(m[2]); cfg[m[1]] = /^\d+$/.test(v) ? parseInt(v, 10) : v; }
  }
  return cfg;
}
const unquote = s => s.replace(/^["']|["']$/g, '');

// ---- file walk ----
function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.planning') { /* skip dotfiles except .planning */ }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) yield* walk(full); }
    else if (e.isFile()) yield full;
  }
}
function readText(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch { return null; }
}
const rel = (root, f) => path.relative(root, f).replace(/\\/g, '/');

// ---- collectors ----
function collectMarkers(root, cfg) {
  const out = [];
  const res = cfg.markers.map(m => ({ m, re: new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
  for (const file of walk(root)) {
    if (/\.askberg\.(example\.)?ya?ml$/.test(file) || file.endsWith('discover.js')) continue; // config self-references
    const text = readText(file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const { m, re } of res) {
        const idx = lines[i].search(re);
        if (idx >= 0) {
          const after = lines[i].slice(idx + m.length).trim().replace(/^[-:\s]+/, '');
          out.push({ source: 'marker', marker: m, file: rel(root, file), line: i + 1, text: after || lines[i].trim() });
          break;
        }
      }
    }
  }
  return out;
}
function collectDocs(root, cfg) {
  const out = [];
  const seen = new Set();
  const targets = [];
  for (const p of cfg.docPaths) {
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) { for (const f of walk(abs)) if (/\.(md|txt|adoc|rst)$/i.test(f)) targets.push(f); }
    else targets.push(abs);
  }
  for (const file of targets) {
    const text = readText(file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l && DOC_SIGNALS.test(l) && l.length < 240) {
        const k = rel(root, file) + ':' + i;
        if (seen.has(k)) continue; seen.add(k);
        out.push({ source: 'doc', file: rel(root, file), line: i + 1, text: l.replace(/^[#\-*>\s]+/, '') });
      }
    }
  }
  return out;
}
function sh(cmd, root) { return cp.execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
function collectGit(root) {
  const out = [];
  try { sh('git rev-parse --is-inside-work-tree', root); } catch { return out; }
  try {
    const porcelain = sh('git status --porcelain', root).split(/\r?\n/).filter(Boolean);
    if (porcelain.length) out.push({ source: 'git', kind: 'wip', text: `Uncommitted changes in ${porcelain.length} file(s) — commit, stash, or discard?` });
  } catch {}
  try {
    for (const l of sh('git branch -vv', root).split(/\r?\n/)) {
      const m = l.match(/\[[^\]]*ahead (\d+)[^\]]*behind (\d+)/);
      if (m) out.push({ source: 'git', kind: 'branch', text: `Branch ${l.trim().split(/\s+/)[0].replace('*', '')} is ${m[1]} ahead / ${m[2]} behind — merge, rebase, or drop?` });
    }
  } catch {}
  return out;
}
function collectGh(root, cfg) {
  const out = [];
  try { sh('gh --version', root); } catch { return out; }
  const owner = (cfg.owner || '@me').replace(/^@/, '') === 'me' ? '@me' : cfg.owner;
  try {
    const prs = JSON.parse(sh(`gh pr list --search "review-requested:${owner} state:open" --json number,title,url --limit 30`, root) || '[]');
    for (const p of prs) out.push({ source: 'gh', kind: 'pr', file: p.url, text: `PR #${p.number} awaiting your review: ${p.title}` });
  } catch {}
  try {
    const issues = JSON.parse(sh(`gh issue list --assignee ${owner} --label "question,blocked,decision" --state open --json number,title,url --limit 30`, root) || '[]');
    for (const it of issues) out.push({ source: 'gh', kind: 'issue', file: it.url, text: `Issue #${it.number} needs a call: ${it.title}` });
  } catch {}
  return out;
}
function collectLedger(root) {
  const out = [];
  const f = path.join(root, '.askberg', 'ledger.md');
  if (!fs.existsSync(f)) return out;
  for (const l of readText(f).split(/\r?\n/)) {
    const t = l.trim();
    if (t.startsWith('[')) out.push({ source: 'ledger', text: t });
  }
  return out;
}

// ---- resolve (strike-on-answer) ----
function resolve(root, file, line) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const i = parseInt(line, 10) - 1;
  if (i < 0 || i >= lines.length) { console.error('line out of range'); process.exit(1); }
  if (!/askberg: resolved/.test(lines[i])) lines[i] += '  <!-- askberg: resolved -->';
  fs.writeFileSync(abs, lines.join('\n'));
  console.log(`Struck ${file}:${line}`);
}

// ---- main ----
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*|^\s?\*?/gm, '')); return; }
  const root = path.resolve(argv.find(a => !a.startsWith('-')) || '.');
  if (argv[0] === '--resolve') { resolve(root, argv[1], argv[2]); return; }

  const cfg = loadConfig(root);
  const candidates = [
    ...collectMarkers(root, cfg),
    ...collectDocs(root, cfg),
    ...collectGit(root),
    ...collectGh(root, cfg),
    ...collectLedger(root),
  ];

  if (argv.includes('--stats')) {
    const by = {};
    for (const c of candidates) by[c.source] = (by[c.source] || 0) + 1;
    console.log(`askberg: ${candidates.length} candidate gate(s)`);
    for (const k of Object.keys(by)) console.log(`  ${k.padEnd(8)} ${by[k]}`);
    return;
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(candidates, null, 2)); return; }

  const dir = path.join(root, '.askberg');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'candidates.json');
  fs.writeFileSync(outFile, JSON.stringify(candidates, null, 2));
  console.log(`askberg: ${candidates.length} candidate gate(s) → ${rel(root, outFile)}`);
  console.log('Next: grade these into a questions.json (drop non-gates, add recommended defaults), then build-form.js.');
}
main();
