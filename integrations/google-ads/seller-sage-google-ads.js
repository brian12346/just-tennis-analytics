/**
 * Seller Sage Pro: Google Ads spend -> dashboard
 *
 * Runs inside Google Ads (Tools -> Bulk actions -> Scripts). Sends daily spend by campaign for the last
 * DAYS days (today included, so it keeps updating) to the dashboard's database, where it shows as
 * "Ad spend" in All sales and comes off the store's profit. Re-sending the same days is safe: they're replaced.
 *
 * Setup: paste the key from Supabase -> Vault -> google_ads_ingest_key into INGEST_KEY, set STORE,
 * click Preview to test, then Run once and schedule it (Hourly or Daily).
 */
var STORE = 'justtennis';            // 'justtennis' or 'acenrally' (the Ace n Rally account's copy of this script)
var INGEST_KEY = 'PASTE_KEY_FROM_VAULT';
var DAYS = 400;                       // first run fills about a year; later runs refresh the same window

// Supabase project (public URL and publishable key; the INGEST_KEY is what lets the script write)
var URL = 'https://ppmzrlqvrhzfxobvnlon.supabase.co/rest/v1/rpc/jt_google_ads_ingest';
var PUBLISHABLE_KEY = 'sb_publishable_nPVLpNx1vs2qfpEK7nFmag_5Z3NqDYb';

function main() {
  var acct = AdsApp.currentAccount(), tz = acct.getTimeZone();
  var to = new Date(), from = new Date(to.getTime() - (DAYS - 1) * 86400000);
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  var q = 'SELECT segments.date, campaign.id, campaign.name, campaign.advertising_channel_type, metrics.cost_micros, ' +
          'metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value ' +
          'FROM campaign WHERE segments.date BETWEEN "' + fmt(from) + '" AND "' + fmt(to) + '"';
  var it = AdsApp.search(q), rows = [], total = 0;
  while (it.hasNext()) {
    var r = it.next(), m = r.metrics || {}, cost = Number(m.costMicros || 0) / 1e6;
    if (!cost && !Number(m.clicks || 0) && !Number(m.impressions || 0)) continue;
    rows.push({ day: r.segments.date, campaign_id: String(r.campaign.id), campaign: r.campaign.name, type: r.campaign.advertisingChannelType,
                cost: Math.round(cost * 100) / 100, clicks: Number(m.clicks || 0), impressions: Number(m.impressions || 0),
                conversions: Number(m.conversions || 0), conv_value: Number(m.conversionsValue || 0) });
    total += cost;
  }
  var payload = { p: { key: INGEST_KEY, store: STORE, from: fmt(from), to: fmt(to), rows: rows,
    account: { id: acct.getCustomerId(), name: acct.getName(), tz: tz, currency: acct.getCurrencyCode() } } };
  var res = UrlFetchApp.fetch(URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + PUBLISHABLE_KEY }, payload: JSON.stringify(payload) });
  var code = res.getResponseCode(), body = res.getContentText();
  Logger.log('Sent ' + rows.length + ' campaign-days, $' + total.toFixed(2) + ' (' + fmt(from) + ' to ' + fmt(to) + '): ' + code + ' ' + body.slice(0, 300));
  if (code >= 300) throw new Error('Dashboard refused the data (' + code + '): ' + body.slice(0, 300));
}
