#!/usr/bin/env node
"use strict";

// Emits a status timeline so the page can draw a real 24-hour strip.
//
// Upptime publishes no sub-day data: history/summary.json carries only
// dailyMinutesDown, and api/*.json are shields.io badge payloads, not a series.
// The sub-day record exists only in the git history of history/<slug>.yml --
// and that file is committed on status CHANGE, not on every check, so its
// history is a list of transitions. That is the better primitive anyway: a
// transition at 18:29 followed by one at 00:52 means down for exactly that
// span, with none of the gaps a five-minute sample would leave.
//
// Reading it here, at build time, keeps the page same-origin: no GitHub API, no
// rate limit, and it still works if the repo is ever made private.

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

var WINDOW_HOURS = Number(process.env.TIMELINE_WINDOW_HOURS || 26);
// Transitions are rare (single digits per day), so this reaches back months
// while staying one cheap git call.
var MAX_COMMITS = 500;
var outPath = process.argv[2] || "_site/timeline.json";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

// The YAML is machine-written and flat, so a line match is enough -- pulling in
// a parser for three scalar keys would be the heavier dependency.
function field(yml, key) {
  var m = yml.match(new RegExp("^" + key + ":[ \t]*(.+?)[ \t]*$", "m"));
  return m ? m[1] : null;
}

function parsePoint(yml) {
  var when = field(yml, "lastUpdated") || field(yml, "startTime");
  var status = field(yml, "status");
  if (!when || !status) return null;
  var ts = Date.parse(when);
  return isFinite(ts) ? { ts: ts, s: status } : null;
}

var summary = JSON.parse(fs.readFileSync("history/summary.json", "utf8"));
var cutoff = Date.now() - WINDOW_HOURS * 3600 * 1000;
var monitors = {};
var total = 0;

summary.forEach(function (site) {
  var file = "history/" + site.slug + ".yml";
  var shas = [];
  try {
    shas = git(["log", "-n", String(MAX_COMMITS), "--format=%H", "--", file])
      .split("\n").filter(Boolean);
  } catch (err) {
    console.warn("No git log for " + file + ": " + err.message);
  }

  var points = [];
  var seen = Object.create(null);
  shas.forEach(function (sha) {
    var body;
    try {
      body = git(["show", sha + ":" + file]);
    } catch (err) {
      return; // The file did not exist at that commit.
    }
    var p = parsePoint(body);
    if (!p || seen[p.ts]) return;
    seen[p.ts] = true;
    points.push(p);
  });

  points.sort(function (a, b) { return a.ts - b.ts; });

  // Each point holds until the next one, so the window's opening state comes
  // from the last transition BEFORE the window -- drop it and a service that
  // went down yesterday and stayed down reads as "no data" this morning.
  var firstInWindow = points.findIndex(function (p) { return p.ts >= cutoff; });
  var start = firstInWindow === -1 ? points.length - 1 : Math.max(0, firstInWindow - 1);
  var kept = points.slice(start < 0 ? 0 : start);

  monitors[site.slug] = kept.map(function (p) {
    return { t: new Date(p.ts).toISOString(), s: p.s };
  });
  total += kept.length;
  console.log(site.slug + ": " + kept.length + " transitions (" + points.length + " known)");
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  generated: new Date().toISOString(),
  windowHours: WINDOW_HOURS,
  monitors: monitors
}));

// Not fatal: a shallow checkout or a brand-new monitor legitimately yields
// nothing, and the page then says so rather than inventing bars.
if (!total) console.warn("No transitions found -- the 24h view will show no data.");
