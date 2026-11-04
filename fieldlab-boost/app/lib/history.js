'use strict';
const fs = require('fs'), path = require('path');
function createHistory(dir) {
  const file = path.join(dir, 'history.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  return {
    list: () => read(),
    add(entry) {
      const all = read(); all.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), ...entry });
      const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(all.slice(0, 1000), null, 1)); fs.renameSync(tmp, file);
      return all[0];
    },
  };
}
module.exports = { createHistory };
