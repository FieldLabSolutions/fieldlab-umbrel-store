'use strict';
// Minimal Podcasting 2.0 RSS parser (no deps). Handles channel + item <podcast:value>.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  if (s == null) return s;
  s = s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  }).trim();
}
function attrs(tag) {
  const o = {};
  tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (m, k, _v, a, b) => { o[k] = decode(a ?? b); });
  return o;
}
function textOf(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : null;
}
function parseValueBlock(xml) {
  const m = xml.match(/<podcast:value\b([^>]*?)(\/>|>([\s\S]*?)<\/podcast:value>)/i);
  if (!m) return null;
  const a = attrs(m[1]);
  const recipients = [];
  const body = m[3] || '';
  for (const r of body.matchAll(/<podcast:valueRecipient\b([^>]*?)\/?>/gi)) {
    const ra = attrs(r[1]);
    recipients.push({
      name: ra.name || '',
      type: (ra.type || '').toLowerCase(),
      address: ra.address || '',
      customKey: ra.customKey || null,
      customValue: ra.customValue || null,
      split: Number(ra.split) || 0,
      fee: String(ra.fee).toLowerCase() === 'true',
    });
  }
  return { type: (a.type || '').toLowerCase(), method: (a.method || '').toLowerCase(), suggested: a.suggested || null, recipients };
}
function parseFeed(xml) {
  const ch = xml.match(/<channel\b[^>]*>([\s\S]*)<\/channel>/i);
  if (!ch) throw new Error('Not an RSS feed (no <channel>)');
  const channelXml = ch[1];
  const firstItem = channelXml.search(/<item\b/i);
  const head = firstItem >= 0 ? channelXml.slice(0, firstItem) : channelXml;
  const img = head.match(/<itunes:image\b([^>]*)\/?>/i);
  const image = img ? attrs(img[1]).href : textOf(textOf(head, 'image') ? head.match(/<image\b[^>]*>[\s\S]*?<\/image>/i)[0] : '', 'url');
  const guidTag = textOf(head, 'podcast:guid');
  const items = [];
  for (const it of channelXml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const x = it[1];
    items.push({ title: textOf(x, 'title') || '(untitled)', guid: textOf(x, 'guid'), pubDate: textOf(x, 'pubDate'), value: parseValueBlock(x) });
  }
  return { title: textOf(head, 'title') || '(untitled show)', author: textOf(head, 'itunes:author'), image: image || null, podcastGuid: guidTag, value: parseValueBlock(head), items };
}
// Item value block overrides channel block (Podcasting 2.0 spec).
function effectiveValue(feed, itemIndex) {
  const item = feed.items[itemIndex];
  return (item && item.value && item.value.recipients.length) ? item.value : feed.value;
}
// Split total sats across recipients. Fee recipients take split as percent off the top;
// the remainder is shared by non-fee recipients proportionally to their split shares.
function computeSplits(recipients, totalSats) {
  const total = Math.floor(Number(totalSats));
  if (!(total > 0)) throw new Error('Amount must be > 0 sats');
  const rs = recipients.filter(r => r.split > 0);
  const out = rs.map(r => ({ ...r, sats: 0 }));
  let remaining = total;
  for (const r of out) if (r.fee) { r.sats = Math.floor(total * r.split / 100); remaining -= r.sats; }
  const shares = out.filter(r => !r.fee);
  const sum = shares.reduce((s, r) => s + r.split, 0);
  let given = 0;
  for (const r of shares) { r.sats = Math.floor(remaining * r.split / sum); given += r.sats; }
  // leftover sats from rounding go to the largest share
  if (shares.length && remaining - given > 0) shares.reduce((a, b) => (b.split > a.split ? b : a)).sats += remaining - given;
  return out;
}
module.exports = { parseFeed, parseValueBlock, effectiveValue, computeSplits, decode };
