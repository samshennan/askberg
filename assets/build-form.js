#!/usr/bin/env node
/*
 * build-form.js — turn a decisions JSON into a self-contained, phone-answerable HTML form.
 *
 * Usage:
 *   node build-form.js <questions.json> [out.html]
 *
 * Input JSON shape (see example.questions.json for the full schema):
 *   { "meta": { "title", "date", "subtitle?", "urgency?": {red,amber,grey} },
 *     "questions": [ { id, cluster, urgency, question, context?, type?,
 *                      options:[{value,label,recommended?,desc?}],
 *                      allowNotes?, notesHint? }, ... ] }
 * A bare array is also accepted (meta defaults applied).
 *
 * The engine (form-template.html) is frozen — this script only injects data,
 * so every form behaves identically to the one that shipped 2026-07-14.
 */
const fs = require('fs');
const path = require('path');

const [, , qPath, outArg] = process.argv;
if (!qPath) {
  console.error('Usage: node build-form.js <questions.json> [out.html]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(qPath, 'utf8'));
const questions = Array.isArray(raw) ? raw : (raw.questions || []);
const metaIn = Array.isArray(raw) ? {} : (raw.meta || {});

if (!questions.length) {
  console.error('No questions found in ' + qPath);
  process.exit(1);
}

const meta = {
  title: metaIn.title || 'Decisions',
  date: metaIn.date || '',
  urgency: metaIn.urgency || { red: 'urgent', amber: 'this week', grey: 'when convenient' },
};
const subtitle = metaIn.subtitle ||
  'the tip is the light stuff; the deeper you dive, the more a call can sink us — recommended is pre-selected, and the output at the bottom pastes straight back to Claude';

// JSON-in-JS injection: escape "<" so a stray "</script>" or "<code>" in any
// context/label can't terminate the script tag or break parsing. "<" round-trips
// back to "<" at runtime, so innerHTML still renders inline markup as intended.
const asJs = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const tpl = fs.readFileSync(path.join(__dirname, 'form-template.html'), 'utf8');

// Function replacements so a literal "$" in any field can't be read as a
// replacement pattern ($&, $1, ...). Quoted tokens are swapped whole, so the
// injected JSON becomes the entire right-hand side — no leftover default.
const titleLine = meta.title + (meta.date ? ' · ' + meta.date : '');
const html = tpl
  .replace('__TITLE__', () => esc(titleLine))
  .replace('__H1__', () => esc(meta.title))
  .replace('__SUB__', () => esc(subtitle))
  .replace('"__META_JSON__"', () => asJs(meta))
  .replace('"__QUESTIONS_JSON__"', () => asJs(questions));

const out = outArg || path.join(process.cwd(), `DECISIONS_${meta.date || 'form'}.html`);
fs.writeFileSync(out, html);
console.log(`Wrote ${out}  (${questions.length} decisions, ${questions.filter(q => q.urgency === 'red').length} urgent)`);
