'use strict';
const fs = require('fs'), path = require('path');
// Saved podcasts, persisted in <dataDir>/shows.json. Keyed by feedUrl.
function createShows(dir) {
  const file = path.join(dir, 'shows.json');
  const read = () => { try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
  const write = all => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(all, null, 1)); fs.renameSync(tmp, file); };
  return {
    list: () => read().sort((a, b) => a.name.localeCompare(b.name)),
    add({ name, feedUrl, artwork } = {}) {
      feedUrl = String(feedUrl || '').trim(); name = String(name || '').trim().slice(0, 200);
      if (!/^https?:\/\//i.test(feedUrl)) throw new Error('Feed URL must start with http(s)://');
      if (!name) throw new Error('Show name required');
      const show = { name, feedUrl, artwork: /^https?:\/\//i.test(artwork || '') ? String(artwork) : '' };
      const all = read().filter(s => s.feedUrl !== feedUrl); all.push(show); write(all);
      return show;
    },
    remove(feedUrl) { const all = read(); const rest = all.filter(s => s.feedUrl !== feedUrl); write(rest); return all.length !== rest.length; },
  };
}
module.exports = { createShows };
