'use strict';
const crypto = require('crypto');
const KEYSEND_PREIMAGE = '5482373484';
const BOOSTAGRAM = '7629169';
function buildBoostRecord(o) {
  return {
    podcast: o.podcast, feedID: o.feedID, guid: o.podcastGuid, url: o.feedUrl,
    episode: o.episode, episode_guid: o.episodeGuid, action: 'boost',
    app_name: 'Dirty Boost Whore', app_version: '0.1.0',
    value_msat: o.valueMsat, value_msat_total: o.valueMsatTotal,
    sender_name: o.senderName, message: o.message, name: o.recipientName,
    ts: o.ts,
  };
}
// Returns LND SendPaymentSync body plus the hex hash/preimage for history.
function buildKeysend({ dest, sats, boost, customKey, customValue, preimage }) {
  if (!/^0[23][0-9a-f]{64}$/i.test(dest)) throw new Error('Bad node pubkey: ' + dest);
  const pre = preimage || crypto.randomBytes(32);
  const hash = crypto.createHash('sha256').update(pre).digest();
  const rec = {
    [KEYSEND_PREIMAGE]: pre.toString('base64'),
    [BOOSTAGRAM]: Buffer.from(JSON.stringify(boost)).toString('base64'),
  };
  if (customKey && customValue) {
    if (!/^\d+$/.test(customKey)) throw new Error('customKey must be numeric');
    rec[customKey] = Buffer.from(String(customValue)).toString('base64');
  }
  return {
    body: { dest: Buffer.from(dest, 'hex').toString('base64'), amt: String(sats), payment_hash: hash.toString('base64'), dest_custom_records: rec, fee_limit: { fixed: String(Math.max(10, Math.ceil(sats * 0.05))) } },
    preimageHex: pre.toString('hex'), paymentHashHex: hash.toString('hex'),
  };
}
module.exports = { buildKeysend, buildBoostRecord, KEYSEND_PREIMAGE, BOOSTAGRAM };
