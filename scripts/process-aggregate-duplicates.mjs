import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportName = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length) || 'duplicate.md';
const reportPath = path.join(root, reportName);
const removedPath = path.join(root, 'removed.txt');
const write = process.argv.includes('--write');
const verbose = process.argv.includes('--verbose');

const numeralChars = '〇○零一二三四五六七八九十百千万两0-9';
const numberedRe = new RegExp(`·其([${numeralChars}]+)(?=·|$)`);
const stripNumberRe = new RegExp(`·其[${numeralChars}]+(?=·|$)`, 'g');
const declaredCountRe = new RegExp(
  `([${numeralChars}]+)(?:首|曲|篇|章|阕|咏|绝|诗|景|物|题|唱|韵)(?=·|，|。|、|并|$)`,
  'g',
);

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, '○': 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if (![...value].some((c) => c in units)) {
    const joined = [...value].map((c) => digits[c]).join('');
    return /^\d+$/.test(joined) ? Number(joined) : NaN;
  }
  let total = 0;
  let section = 0;
  let number = 0;
  for (const c of value) {
    if (c in digits) {
      number = digits[c];
    } else if (c === '万') {
      section += number;
      total += section * 10000;
      section = 0;
      number = 0;
    } else if (c in units) {
      section += (number || 1) * units[c];
      number = 0;
    } else {
      return NaN;
    }
  }
  return total + section + number;
}

function titleInfo(record, index) {
  const match = record.title.match(numberedRe);
  if (!match) return null;
  const number = chineseNumber(match[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  return {
    ...record,
    index,
    number,
    base: record.title.slice(0, match.index),
  };
}

function declaredCount(title) {
  let maximum = 0;
  for (const match of title.matchAll(declaredCountRe)) {
    const value = chineseNumber(match[1]);
    if (Number.isInteger(value)) maximum = Math.max(maximum, value);
  }
  return maximum;
}

function endpointKey(author, title) {
  return `${author}\u0000${title}`;
}

function pairKey(authorA, titleA, authorB, titleB) {
  return [endpointKey(authorA, titleA), endpointKey(authorB, titleB)].sort().join('\u0001');
}

function rowSignature(authorA, titleA, authorB, titleB, verses) {
  return `${pairKey(authorA, titleA, authorB, titleB)}\u0002${[...new Set(verses)].sort().join('\u0003')}`;
}

function parseEndpoint(cell) {
  const match = cell.match(/^《([\s\S]*)》<br>作者：([\s\S]*)$/);
  if (!match) return null;
  return { title: match[1], author: match[2] };
}

function parseReport(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = new Map();
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^## (.+?\.json)(?:（\d+ 对）)?$/);
    if (heading) {
      current = heading[1];
      if (!sections.has(current)) sections.set(current, { rows: [], endpoints: new Set() });
      continue;
    }
    if (!current) continue;
    const row = lines[index].match(/^\|\s*(D\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
    if (!row) continue;
    const a = parseEndpoint(row[2]);
    const b = parseEndpoint(row[3]);
    if (!a || !b) continue;
    const verses = row[4].split('<br>').map((v) => v.trim()).filter(Boolean);
    const parsed = {
      lineIndex: index,
      id: row[1],
      a,
      b,
      verses,
      signature: rowSignature(a.author, a.title, b.author, b.title, verses),
    };
    sections.get(current).rows.push(parsed);
    sections.get(current).endpoints.add(endpointKey(a.author, a.title));
    sections.get(current).endpoints.add(endpointKey(b.author, b.title));
  }
  return { lines, sections };
}

function dynastyFromPath(reportFile) {
  return reportFile.split('/')[0].replace(/^\d+\./, '');
}

function sameVersesAt(aggregate, offset, section) {
  if (!Array.isArray(section.verses) || section.verses.length === 0) return false;
  if (offset + section.verses.length > aggregate.verses.length) return false;
  return section.verses.every((verse, index) => aggregate.verses[offset + index] === verse);
}

function hasOrderedSectionChain(pool, selected, aggregateTitle) {
  const selectedByNumber = new Map();
  for (const item of selected) {
    if (selectedByNumber.has(item.number)) return false;
    selectedByNumber.set(item.number, item);
  }
  const selectedMaximum = Math.max(...selected.map((item) => item.number));
  const maximum = Math.max(selectedMaximum, declaredCount(aggregateTitle));
  const existingNumbers = [...new Set(pool.map((item) => item.number))]
    .filter((number) => number <= maximum)
    .sort((a, b) => a - b);
  let previousIndex = -1;
  for (const number of existingNumbers) {
    const fixed = selectedByNumber.get(number);
    if (fixed) {
      if (fixed.index <= previousIndex) return false;
      previousIndex = fixed.index;
      continue;
    }
    const next = pool.find((item) => item.number === number && item.index > previousIndex);
    if (!next) return false;
    previousIndex = next.index;
  }
  return true;
}

function findSegmentation(aggregate, pool, relatedIds) {
  if (!Array.isArray(aggregate.verses) || aggregate.verses.length === 0) return null;
  const candidatesAt = new Map();
  for (let offset = 0; offset < aggregate.verses.length; offset += 1) {
    const matches = pool.filter((item) => sameVersesAt(aggregate, offset, item));
    if (matches.length) candidatesAt.set(offset, matches);
  }
  const chosen = [];
  const used = new Set();
  function visit(offset) {
    if (offset === aggregate.verses.length) {
      if (chosen.length < 2) return null;
      if (!chosen.some((item) => relatedIds.has(item.id))) return null;
      if (!hasOrderedSectionChain(pool, chosen, aggregate.title)) return null;
      return [...chosen];
    }
    for (const item of candidatesAt.get(offset) ?? []) {
      if (used.has(item.id)) continue;
      used.add(item.id);
      chosen.push(item);
      const found = visit(offset + item.verses.length);
      if (found) return found;
      chosen.pop();
      used.delete(item.id);
    }
    return null;
  }
  return visit(0);
}

function cjkLength(value) {
  return [...value].filter((c) => /[\p{Script=Han}]/u.test(c)).length;
}

function commonVerses(a, b) {
  const bSet = new Set(b.verses ?? []);
  return [...new Set((a.verses ?? []).filter((verse) => bSet.has(verse)))];
}

const markdown = fs.readFileSync(reportPath, 'utf8');
const report = parseReport(markdown);
const files = [];
const missingFiles = [];

for (const [reportFile, section] of report.sections) {
  if (reportName === 'duplicate.md' && reportFile.startsWith('11.宋/')) continue;
  let absolute = path.join(root, ...reportFile.split('/'));
  if (!fs.existsSync(absolute)) {
    const padded = reportFile.replace(/_(\d+)\.json$/, (_, number) => `_${number.padStart(2, '0')}.json`);
    absolute = path.join(root, ...padded.split('/'));
  }
  if (!fs.existsSync(absolute)) {
    missingFiles.push(reportFile);
    continue;
  }
  files.push({ reportFile, absolute, section, records: JSON.parse(fs.readFileSync(absolute, 'utf8')) });
}

const candidates = [];
for (const file of files) {
  const numbered = file.records.map(titleInfo).filter(Boolean);
  const byAuthorBase = new Map();
  const exact = new Map();
  const stripped = new Map();
  for (const item of numbered) {
    const groupKey = endpointKey(item.authorName, item.base);
    if (!byAuthorBase.has(groupKey)) byAuthorBase.set(groupKey, []);
    byAuthorBase.get(groupKey).push(item);
    const exactKey = endpointKey(item.authorName, item.title);
    if (!exact.has(exactKey)) exact.set(exactKey, []);
    exact.get(exactKey).push(item);
    const strippedKey = endpointKey(item.authorName, item.title.replace(stripNumberRe, ''));
    if (!stripped.has(strippedKey)) stripped.set(strippedKey, []);
    stripped.get(strippedKey).push(item);
  }

  for (const aggregate of file.records) {
    const key = endpointKey(aggregate.authorName, aggregate.title);
    if (!file.section.endpoints.has(key)) continue;
    const related = [
      ...(exact.get(key) ?? []),
      ...(stripped.get(key) ?? []),
    ].filter((item) => item.id !== aggregate.id);
    if (!related.length) continue;
    const relatedIds = new Set(related.map((item) => item.id));
    const bases = new Set(related.map((item) => item.base));
    for (const base of bases) {
      const pool = (byAuthorBase.get(endpointKey(aggregate.authorName, base)) ?? [])
        .filter((item) => item.id !== aggregate.id && item.verses.length < aggregate.verses.length);
      const segmentation = findSegmentation(aggregate, pool, relatedIds);
      if (!segmentation) continue;
      candidates.push({
        file,
        aggregate,
        base,
        segmentation,
        dynasty: aggregate.dynasty || dynastyFromPath(file.reportFile),
      });
      break;
    }
  }
}

const selectedCandidates = [];
const reportLineIndexes = new Set();
const unmatchedCandidatePairs = [];

for (const candidate of candidates) {
  const availableBySignature = new Map();
  for (const row of candidate.file.section.rows) {
    if (!availableBySignature.has(row.signature)) availableBySignature.set(row.signature, []);
    availableBySignature.get(row.signature).push(row.lineIndex);
  }
  const expected = [];
  for (const other of candidate.file.records) {
    if (other.id === candidate.aggregate.id) continue;
    const common = commonVerses(candidate.aggregate, other);
    if (common.reduce((sum, verse) => sum + cjkLength(verse), 0) < 4) continue;
    expected.push({
      other,
      signature: rowSignature(
        candidate.aggregate.authorName,
        candidate.aggregate.title,
        other.authorName,
        other.title,
        common,
      ),
    });
  }
  let matched = 0;
  for (const pair of expected) {
    const indexes = availableBySignature.get(pair.signature);
    if (indexes?.length) {
      const lineIndex = indexes.shift();
      if (!reportLineIndexes.has(lineIndex)) {
        reportLineIndexes.add(lineIndex);
        matched += 1;
      }
    } else {
      unmatchedCandidatePairs.push({ candidate, other: pair.other });
    }
  }
  if (matched > 0) {
    selectedCandidates.push({ ...candidate, matchedRows: matched });
  }
}

const selectedIds = new Set(selectedCandidates.map((item) => item.aggregate.id));
// If two candidates share an indistinguishable report row, ensure every row involving either
// deleted record is removed by matching again against the combined candidate set.
for (const file of files) {
  const deleted = file.records.filter((record) => selectedIds.has(record.id));
  if (!deleted.length) continue;
  const signatureCounts = new Map();
  for (const aggregate of deleted) {
    for (const other of file.records) {
      if (other.id === aggregate.id) continue;
      const common = commonVerses(aggregate, other);
      if (common.reduce((sum, verse) => sum + cjkLength(verse), 0) < 4) continue;
      const signature = rowSignature(aggregate.authorName, aggregate.title, other.authorName, other.title, common);
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    }
  }
  for (const row of file.section.rows) {
    const count = signatureCounts.get(row.signature) ?? 0;
    if (count > 0) {
      reportLineIndexes.add(row.lineIndex);
      signatureCounts.set(row.signature, count - 1);
    }
  }
}

const byFile = new Map();
for (const candidate of selectedCandidates) {
  if (!byFile.has(candidate.file.reportFile)) byFile.set(candidate.file.reportFile, []);
  byFile.get(candidate.file.reportFile).push(candidate);
}

console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  reportFiles: files.length,
  missingFiles,
  candidatesFound: candidates.length,
  candidatesWithReportRows: selectedCandidates.length,
  reportRowsToRemove: reportLineIndexes.size,
  unmatchedCandidatePairs: unmatchedCandidatePairs.length,
  byFile: [...byFile].map(([file, items]) => ({ file, count: items.length })),
}, null, 2));

for (const candidate of verbose ? selectedCandidates : selectedCandidates.slice(0, 20)) {
  console.log([
    candidate.file.reportFile,
    candidate.aggregate.id,
    candidate.aggregate.authorName,
    candidate.aggregate.title,
    candidate.segmentation.map((item) => `其${item.number}`).join('+'),
    `${candidate.matchedRows} rows`,
  ].join('\t'));
}
if (!verbose && selectedCandidates.length > 20) {
  console.log(`... ${selectedCandidates.length - 20} more candidates (use --verbose to list all)`);
}
for (const item of unmatchedCandidatePairs.slice(0, 20)) {
  console.log([
    'UNMATCHED-PAIR',
    item.candidate.file.reportFile,
    item.candidate.aggregate.id,
    item.candidate.aggregate.authorName,
    item.candidate.aggregate.title,
    item.other.id,
    item.other.authorName,
    item.other.title,
  ].join('\t'));
}

if (!write) process.exit(0);

for (const file of files) {
  const ids = new Set((byFile.get(file.reportFile) ?? []).map((item) => item.aggregate.id));
  if (!ids.size) continue;
  const next = file.records.filter((record) => !ids.has(record.id));
  fs.writeFileSync(file.absolute, `${JSON.stringify(next, null, 2)}\n`);
}

const remainingLines = report.lines.filter((_, index) => !reportLineIndexes.has(index));
const rowCounts = new Map();
let active = null;
for (const line of remainingLines) {
  const heading = line.match(/^## (.+?\.json)(?:（\d+ 对）)?$/);
  if (heading) {
    active = heading[1];
    if (!rowCounts.has(active)) rowCounts.set(active, 0);
  } else if (active && /^\|\s*D\d+\s*\|/.test(line)) {
    rowCounts.set(active, rowCounts.get(active) + 1);
  }
}
const updatedLines = remainingLines.map((line) => {
  const heading = line.match(/^## (.+?\.json)（\d+ 对）$/);
  if (!heading || !byFile.has(heading[1])) return line;
  return `## ${heading[1]}（${rowCounts.get(heading[1]) ?? 0} 对）`;
});
fs.writeFileSync(reportPath, updatedLines.join('\n'));

const existingRemoved = fs.existsSync(removedPath) ? fs.readFileSync(removedPath, 'utf8') : '';
const additions = selectedCandidates
  .map((item) => `〔${item.dynasty}·${item.aggregate.authorName}〕${item.aggregate.title}`)
  .filter((line) => !existingRemoved.split(/\r?\n/).includes(line));
if (additions.length) {
  const separator = existingRemoved.length && !existingRemoved.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(removedPath, `${separator}${additions.join('\n')}\n`);
}
