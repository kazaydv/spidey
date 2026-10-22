/* =====================================================================
   SPIDEY SHEETS BRIDGE — runs in Siddhu's own Google account
   (kazayadav@gmail.com). Lets Spidey READ every spreadsheet that account
   can access. It NEVER writes to business/order sheets — the only file
   it ever writes is its own separate "Spidey Memory" spreadsheet.

   >>> ONLY RUN THIS ONE FUNCTION FROM THE DROPDOWN:  setupBridge()  <<<
   Everything else is a helper — never run helpers directly.

   Deploy: Deploy → New deployment → Web app → Execute as: Me,
   Access: Anyone → copy the /exec URL (must end in /exec, NOT /dev).
   ===================================================================== */

// CHANGE THIS before running setupBridge(): any long random text.
// It must match BRIDGE_KEY in the Cloudflare Worker.
var BRIDGE_KEY = "CHANGE_ME_long_random_secret";

// How many spreadsheets to scan for the daily summary (newest first).
var SUMMARY_MAX_FILES = 12;

function setupBridge() {
  PropertiesService.getScriptProperties().setProperty("BRIDGE_KEY", BRIDGE_KEY);
  var mem = getMemorySpreadsheet_();
  Logger.log("Bridge ready.");
  Logger.log("Spidey Memory spreadsheet: " + mem.getUrl());
  Logger.log("Key saved: " + (BRIDGE_KEY !== "CHANGE_ME_long_random_secret" ? "yes (custom)" : "NO — still the placeholder! Edit BRIDGE_KEY and run setupBridge() again."));
  Logger.log("Now deploy as a Web app (Execute as Me, Access Anyone) and put the /exec URL + this key into the Worker secrets.");
}

/* ---------- entry points ---------- */
function doGet(e) { return handle_(e); }
function doPost(e) { return handle_(e); }

function handle_(e) {
  var p = (e && e.parameter) || {};
  var saved = PropertiesService.getScriptProperties().getProperty("BRIDGE_KEY");
  if (!saved || p.key !== saved) return out_({ error: "bad key" });
  try {
    switch (p.action) {
      case "ping":    return out_({ ok: true, account: Session.getActiveUser().getEmail() });
      case "list":    return out_(listSheets_());
      case "tabs":    return out_(tabs_(p.id));
      case "read":    return out_(read_(p.id, p.tab, Number(p.limit) || 20));
      case "summary": return out_(summary_());
      case "log":     return out_(log_(p.session, p.user, p.spidey));
      case "learn":   return out_(learn_(p.fact));
      case "facts":   return out_(facts_());
      default:        return out_({ error: "unknown action" });
    }
  } catch (err) {
    return out_({ error: String(err) });
  }
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- discovery: ALL spreadsheets this account can access ---------- */
function allSpreadsheetFiles_() {
  var files = [], it = DriveApp.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { var f = it.next(); files.push(f); }
  files.sort(function (a, b) { return b.getLastUpdated() - a.getLastUpdated(); });
  return files;
}
function listSheets_() {
  return { sheets: allSpreadsheetFiles_().map(function (f) {
    return { id: f.getId(), name: f.getName(), updated: f.getLastUpdated().toISOString() };
  })};
}
function tabs_(id) {
  var ss = SpreadsheetApp.openById(id);
  return { name: ss.getName(), tabs: ss.getSheets().map(function (s) {
    return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() };
  })};
}
function read_(id, tab, limit) {
  var ss = SpreadsheetApp.openById(id);
  var sh = tab ? ss.getSheetByName(tab) : ss.getSheets()[0];
  if (!sh) return { error: "tab not found" };
  var last = sh.getLastRow(); if (!last) return { name: ss.getName(), tab: sh.getName(), rows: [] };
  var start = Math.max(1, last - limit + 1);
  var values = sh.getRange(start, 1, last - start + 1, Math.min(sh.getLastColumn(), 15)).getValues();
  return { name: ss.getName(), tab: sh.getName(), rows: values.map(function (r) {
    return r.map(function (c) { return (c instanceof Date) ? c.toISOString() : c; });
  })};
}

/* ---------- daily summary for the HUD cards + brain context ----------
   Heuristic, read-only: for each recent spreadsheet/tab, find a date-ish
   first column and an amount-ish column (header contains "amount"/"total").
   Counts today's rows and sums today's amounts. Builds a compact text
   context the Worker's brain may quote — the ONLY numbers it may quote. */
function summary_() {
  var tz = "Asia/Kathmandu";
  var todayStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var ordersToday = 0, revenueToday = 0, lines = [];
  var memId = PropertiesService.getScriptProperties().getProperty("MEMORY_ID");
  var files = allSpreadsheetFiles_().slice(0, SUMMARY_MAX_FILES);
  files.forEach(function (f) {
    if (f.getId() === memId) return; // never summarise Spidey's own memory file
    try {
      var ss = SpreadsheetApp.openById(f.getId());
      ss.getSheets().forEach(function (sh) {
        var last = sh.getLastRow(); if (last < 2) return;
        var width = Math.min(sh.getLastColumn(), 15);
        var headers = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).toLowerCase(); });
        var amtCol = -1;
        headers.forEach(function (h, i) { if (amtCol < 0 && (h.indexOf("amount") >= 0 || h.indexOf("total") >= 0)) amtCol = i; });
        var scan = Math.min(last - 1, 400);
        var rows = sh.getRange(last - scan + 1 - 0, 1, scan, width).getValues(); // last up-to-400 data rows; note row offset below uses (last-scan)
        var tCount = 0, tSum = 0;
        rows.forEach(function (r) {
          var d = r[0];
          if (d instanceof Date && Utilities.formatDate(d, tz, "yyyy-MM-dd") === todayStr) {
            tCount++; if (amtCol >= 0 && typeof r[amtCol] === "number") tSum += r[amtCol];
          }
        });
        if (tCount) {
          ordersToday += tCount; revenueToday += tSum;
          lines.push(f.getName() + " / " + sh.getName() + ": " + tCount + " rows today" + (tSum ? ", Rs " + tSum : "") + ".");
        }
      });
    } catch (err) { /* one unreadable file must not break the summary */ }
  });
  var contextText = lines.length
    ? "Today (" + todayStr + ", Nepal): total " + ordersToday + " sheet rows, revenue Rs " + revenueToday + " (from amount/total columns). Breakdown: " + lines.join(" ")
    : "No sheet rows dated today were found in the most recent spreadsheets.";
  return { ordersToday: ordersToday, revenueToday: revenueToday, collegeMail: null, contextText: contextText };
}

/* ---------- Spidey Memory spreadsheet (the ONLY file we write) ---------- */
function getMemorySpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("MEMORY_ID");
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var ss = SpreadsheetApp.create("Spidey Memory");
  var conv = ss.getActiveSheet(); conv.setName("Conversations");
  conv.appendRow(["Timestamp", "Session", "Siddhu said", "Spidey replied"]);
  var facts = ss.insertSheet("Facts"); facts.appendRow(["Timestamp", "Fact"]);
  var rem = ss.insertSheet("Reminders"); rem.appendRow(["Timestamp", "Remind at", "Text", "Sent"]);
  props.setProperty("MEMORY_ID", ss.getId());
  return ss;
}
function log_(session, user, spidey) {
  var ss = getMemorySpreadsheet_();
  ss.getSheetByName("Conversations").appendRow([new Date(), session || "", user || "", spidey || ""]);
  return { ok: true };
}
function learn_(fact) {
  if (!fact) return { error: "no fact" };
  var ss = getMemorySpreadsheet_();
  ss.getSheetByName("Facts").appendRow([new Date(), fact]);
  return { ok: true };
}
function facts_() {
  var ss = getMemorySpreadsheet_();
  var sh = ss.getSheetByName("Facts");
  var last = sh.getLastRow(); if (last < 2) return { facts: [] };
  return { facts: sh.getRange(2, 2, last - 1, 1).getValues().map(function (r) { return r[0]; }) };
}
