from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "reader-dev-v1-draft.jsonl"
OUTPUT = ROOT / "data" / "reader-dev-v1-review.html"

HTML = r'''<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assisted Reader Definition Review</title>
<style>
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #17252a; background: #eef2f1; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; }
  header { background: #163b42; color: #f7faf9; padding: 18px clamp(20px, 4vw, 56px); display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  h1 { font-family: Georgia, serif; font-size: 24px; font-weight: 600; margin: 0; }
  main { max-width: 1160px; margin: 0 auto; padding: 28px clamp(20px, 4vw, 56px) 48px; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 18px; }
  .meta { color: #52666a; font-size: 14px; }
  button, .file-button { appearance: none; border: 1px solid #b8c6c3; border-radius: 4px; background: #fff; color: #17252a; padding: 8px 12px; font: inherit; cursor: pointer; }
  button:hover, .file-button:hover { border-color: #163b42; background: #f6fafa; }
  button:disabled { cursor: not-allowed; opacity: .45; }
  .file-button input { display: none; }
  .primary { background: #16705f; border-color: #16705f; color: white; }
  .primary:hover { background: #0f5d50; }
  .context { border-top: 3px solid #e0b24d; background: #fffdf6; padding: 22px 24px; margin-bottom: 18px; }
  .eyebrow { color: #687c7d; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .context p { font-family: Georgia, serif; font-size: 20px; line-height: 1.55; margin: 10px 0 0; }
  mark { background: #f6d879; padding: 0 2px; }
  .candidates { display: grid; gap: 10px; }
  .candidate { background: white; border: 1px solid #d5dfdc; padding: 14px 16px; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .candidate p { margin: 3px 0 0; line-height: 1.45; }
  .pos { color: #247062; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .segmented { display: flex; border: 1px solid #b8c6c3; border-radius: 4px; overflow: hidden; }
  .segmented button { border: 0; border-right: 1px solid #b8c6c3; border-radius: 0; padding: 7px 9px; font-size: 13px; white-space: nowrap; }
  .segmented button:last-child { border-right: 0; }
  .segmented .fits { background: #cfeadd; color: #124f31; }
  .segmented .plausible { background: #fff0bf; color: #755500; }
  .segmented .wrong { background: #f6d5d6; color: #7a2025; }
  .empty { padding: 40px; text-align: center; color: #52666a; }
  @media (max-width: 680px) { .candidate { grid-template-columns: 1fr; } .segmented { justify-self: start; } header { align-items: flex-start; flex-direction: column; } }
</style>
<header><h1>Definition Review</h1><div id="progress">0 / 0 reviewed</div></header>
<main>
  <div class="toolbar">
    <div><button id="previous">Previous</button> <button id="next">Next</button> <button id="unreviewed">Next unreviewed</button></div>
    <div><label class="file-button">Import CSV<input id="import" type="file" accept=".csv,text/csv"></label> <button id="clear">Clear local labels</button> <button id="export" class="primary">Download CSV</button></div>
  </div>
  <div id="meta" class="meta"></div>
  <section class="context"><div class="eyebrow">Context</div><p id="context"></p></section>
  <section id="candidates" class="candidates"></section>
</main>
<script>
const examples = __DATA__;
const storageKey = 'assisted-reader-reader-dev-v1-review';
const seedLabels = Object.fromEntries(examples.flatMap(example => example.candidates
  .filter(candidate => ['fits', 'plausible', 'clearly_wrong'].includes(candidate.relevance))
  .map(candidate => [`${example.id}:${candidate.sense_id}`, candidate.relevance])));
const labels = {...seedLabels, ...JSON.parse(localStorage.getItem(storageKey) || '{}')};
let index = 0;
const escapeHtml = value => value.replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
const save = () => localStorage.setItem(storageKey, JSON.stringify(labels));
const key = (example, candidate) => `${example.id}:${candidate.sense_id}`;
function contextWithTarget(example) {
  const expression = new RegExp(`\\b(${example.target.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')})\\b`, 'i');
  return escapeHtml(example.context).replace(expression, '<mark>$1</mark>');
}
function reviewed(example) { return example.candidates.every(candidate => labels[key(example, candidate)]); }
function render() {
  const example = examples[index];
  const done = examples.filter(reviewed).length;
  document.getElementById('progress').textContent = `${done} / ${examples.length} contexts reviewed`;
  document.getElementById('meta').textContent = `${index + 1} of ${examples.length}  |  ${example.source.file}  |  ${example.candidates.length} definitions`;
  document.getElementById('context').innerHTML = contextWithTarget(example);
  const container = document.getElementById('candidates');
  container.innerHTML = '';
  for (const candidate of example.candidates) {
    const row = document.createElement('article'); row.className = 'candidate';
    const current = labels[key(example, candidate)];
    row.innerHTML = `<div><div class="pos">${escapeHtml(candidate.part_of_speech)}</div><p>${escapeHtml(candidate.gloss)}</p></div>`;
    const controls = document.createElement('div'); controls.className = 'segmented';
    for (const [label, text, style] of [['fits', 'Fits', 'fits'], ['plausible', 'Plausible', 'plausible'], ['clearly_wrong', 'Wrong', 'wrong']]) {
      const button = document.createElement('button'); button.textContent = text; button.title = label;
      if (current === label) button.className = style;
      button.onclick = () => { labels[key(example, candidate)] = label; save(); render(); };
      controls.append(button);
    }
    row.append(controls); container.append(row);
  }
}
function exportCsv() {
  const rows = [['example_id','source_file','context','target','lemma','part_of_speech','sense_id','gloss','relevance','reviewer_notes']];
  for (const example of examples) for (const candidate of example.candidates) rows.push([example.id, example.source.file, example.context, example.target, example.lemma, candidate.part_of_speech, candidate.sense_id, candidate.gloss, labels[key(example, candidate)] || 'needs_review', '']);
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'})); link.download = 'reader-dev-v1-review.csv'; link.click(); URL.revokeObjectURL(link.href);
}
function importCsv(file) {
  const reader = new FileReader(); reader.onload = () => {
    const lines = String(reader.result).split(/\r?\n/).filter(Boolean); const header = lines.shift().split(',');
    const relevanceIndex = header.indexOf('relevance'), exampleIndex = header.indexOf('example_id'), senseIndex = header.indexOf('sense_id');
    if (relevanceIndex < 0 || exampleIndex < 0 || senseIndex < 0) return alert('This is not a reader-dev review CSV.');
    for (const line of lines) { const fields = [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(match => (match[1] ?? match[2]).replaceAll('""', '"')); const label = fields[relevanceIndex]; if (['fits','plausible','clearly_wrong'].includes(label)) labels[`${fields[exampleIndex]}:${fields[senseIndex]}`] = label; }
    save(); render();
  }; reader.readAsText(file);
}
document.getElementById('previous').onclick = () => { index = (index - 1 + examples.length) % examples.length; render(); };
document.getElementById('next').onclick = () => { index = (index + 1) % examples.length; render(); };
document.getElementById('unreviewed').onclick = () => { const next = examples.findIndex((example, i) => i > index && !reviewed(example)); index = next < 0 ? Math.max(0, examples.findIndex(example => !reviewed(example))) : next; render(); };
document.getElementById('export').onclick = exportCsv;
document.getElementById('clear').onclick = () => { if (confirm('Clear locally edited labels and restore the bundled review labels?')) { localStorage.removeItem(storageKey); location.reload(); } };
document.getElementById('import').onchange = event => event.target.files[0] && importCsv(event.target.files[0]);
render();
</script>'''


def main() -> None:
    examples = [json.loads(line) for line in SOURCE.read_text(encoding="utf-8").splitlines() if line]
    labels: dict[str, str] = {}
    review = ROOT / "data" / "reader-dev-v1-review.csv"
    if review.exists():
        import csv
        with review.open(newline="", encoding="utf-8") as source:
            for row in csv.DictReader(source):
                labels[f"{row['example_id']}:{row['sense_id']}"] = row["relevance"]
    for example in examples:
        for candidate in example["candidates"]:
            candidate["relevance"] = labels.get(f"{example['id']}:{candidate['sense_id']}", "needs_review")
    OUTPUT.write_text(HTML.replace("__DATA__", json.dumps(examples, ensure_ascii=True).replace("</", "<\\/")), encoding="utf-8")
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
