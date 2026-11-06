# 24. History in an append-only log, feeds back to live state

Status: accepted, 2026-11-06. Supersedes the part of [6](0006-feeds.md) and [17](0017-quota-is-provider-and-account.md)
where a feed carries its quota's history.

## Context

Every session's feed carried the whole history of its quota: every reading, prompt and spend of every harness on it,
merged in at each event and the whole file written again. Measured on 2026-11-06: 6.4 MB of feeds held 572 KB of
history, each reading copied 24 times on average, each feed about 200 KB written whole at every event, and feeds of
ended sessions kept forever. The merge was where it went wrong: flattening many copies of the spend into one list
summed them, so spend compounded across feeds at every merge, up to 1.8e308 dollars a bucket.

## Decision

- **A log per session and day:** `~/.local/state/pace/log/<YYYY-MM-DD, UTC>/<host>-<session>.jsonl`. Each line is
  one event the session itself saw: a reading the host was told, a prompt (with its model when known), or what a reply
  cost. A header line names the quota (provider, account) and the session; the lines after it are on that quota until
  the next header.
- **Append-only, one writer.** A file only grows and only its session writes it. The Node hosts append to it; Claude
  Code, whose `$.fs` can only write a file whole, writes its own day's file with the new lines after the old ones, so
  a reader never sees a line change. A reader drops a last line cut short mid-write.
- **Nothing is copied.** Each event is in one file once. Spend is events, so a quota's spend is their sum; no merge
  has to choose between a sum and a maximum.
- **Feeds are live state:** context, cache, auto mode, where the session is. Their history lists are written empty.
- **Readers hydrate.** Wherever feeds are read, `hydrate` (core/log.ts, pure) fills each feed's history from the log
  of the last eight days and from what older feeds still carry, by quota. Everything after it (`meter`, the fleet, the
  views) sees the snapshots it saw before.
- **Checkpoints, and nothing worked out twice.** A finished day (before yesterday, which may still get a late line) is
  folded once into `checkpoint.json` in its folder, each quota's part of it, by the first host to prune that day.
  Readers keep a `History` (core/log.ts): a checkpoint is read once, the open days' files are read on from where they
  were left, and a quota's history is its past, joined at most once an hour, with today's part on top, worked out only
  when one of its parts changed. The same feed objects come back while nothing changed, so a view can tell it has
  nothing to draw again. Feeds are parsed again only once their size or time changed.
- **Retention by whole files.** (Changed by [25](0025-activity.md): checkpoints are kept for good, a day's raw lines
  deleted once it is nine days old.) A Node writer deletes the day folders older than the spend kept (eight days) and
  feeds of sessions that ended before it, at most once a day. Nothing is compacted or rewritten.

## Consequences

- A day of use is tens of kilobytes on disk, written a line at a time, instead of megabytes written whole.
- Older feeds still count while they last, so no history is lost on the way and no migration step runs.
- A pace older than this one reads the slim feeds as sessions with no history.
