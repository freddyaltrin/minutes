# What we could observe about Granola, and what we did with it

Minutes is an independent implementation. It borrows the *shape* of Granola's
meeting-notes experience — the things anyone can see by using the product or
reading about it — and nothing else. No Granola code, assets, fonts, icons,
copy or network behaviour were copied. The branding (the mark, the name, the
palette in `docs/brand.md`) is original. Where Granola relies on a cloud
service, Minutes substitutes something that runs on the user's machine: an
open-source speech model (whisper.cpp, CPU-only) for transcription, and
deterministic rule-based mechanisms for everything that Granola does with a
language model, or it leaves the feature out; the mapping table at the end is
explicit about each substitution and why it was made.

This document separates three things: what was observed from Granola's own
website, what was observed from third-party write-ups, and what was *not*
observed and therefore not claimed.

## Observed from granola.ai (the public homepage and its page metadata)

Notes UI. A note has two tabs, "My notes" and "Enhanced". Status labels seen
on the page are "Transcribing", "Enhancing notes" and "Generate notes". The
empty editor shows the placeholder "Write notes…".

Meeting list. Meetings are listed grouped by date; the current day's group is
headed "Today" and carries a count.

Before, during and after a meeting. Before the meeting there is a pre-meeting
"Your Brief". During the meeting there is an "Ask anything" input. After the
meeting there are quick actions such as "List actions" and "Write follow-up
email", plus "Granola Chat" for conversational questions over past meetings.
Notes can be shared with participants ("Share notes"). A calendar notification
appears with a button to join the meeting.

Supported apps and platforms. Zoom, Google Meet, Microsoft Teams, Slack
Huddles and in-person meetings. Platforms listed: macOS, Windows, iOS, Android.

Pricing. A free tier exists with a 30-day history limit.

Page metadata. The site's `theme-color` is `#ffffff` and the inline logo uses
fill `#1E1E1E`. These are the only two colour values we have from a primary
source, and they describe the website, not necessarily the desktop app.

## Observed from third-party write-ups

Sources: a layer3labs guide to Granola and a community-written "Granola UX
reference" document. These are secondary sources; the points below are
reported as they appear there and have not been independently verified
against the application.

Layout. Minimal chrome with no top toolbar. A left sidebar containing notes,
folders and workspace. A "Recent meetings" list where each row shows title,
time and attendees abbreviated in the form "Jim, Michaela +5". The note title
is edited inline. The note view can be split between raw notes and enhanced
notes.

Transcript. Rendered as chat-style bubbles labelled "Me" and "Them", with
inline timestamps.

Recording. A recording pill with live green level bars; clicking it opens the
transcript. The pill detaches into its own small window when another
application is focused. Recording can auto-start when a meeting begins and
auto-stops after roughly 15 minutes of silence.

Editing and navigation. Templates are inserted with "/". Keyboard shortcuts
reported by the guide: Cmd/Ctrl+J for chat, Cmd/Ctrl+, for settings,
Cmd/Ctrl+S to toggle the sidebar, Cmd/Ctrl+R to refresh. Dark mode is
supported. Notes can be read and edited offline.

Settings. A "Personal jargon" vocabulary setting. CSV export from profile
settings.

Visual character. A low-chroma, paper-like palette; a green accent reserved
for live state; medium-low information density; sans-serif typography,
refreshed in February 2026 according to the UX reference document.

## Not observed, therefore not claimed

Exact font families. Hex values beyond the two in the website metadata.
Spacing, sizes and radii. Empty-state copy. How Windows system-audio capture
is implemented. Anything about Granola's internal architecture, data formats
or the behaviour of its enhancement models. Where Minutes needed a value for
any of these, it was chosen independently (see `docs/brand.md` and
`src/renderer/src/styles/tokens.css`).

## Mapping: Granola element → Minutes equivalent

| Granola element (as observed) | Minutes equivalent | Difference and why |
| --- | --- | --- |
| "Transcribing" status; transcription performed by Granola's service | **Local whisper.cpp transcription**: the bundled `whisper-server` runs an OpenAI Whisper model (tiny/base/small by default, chosen per machine) on the CPU in a worker process; the recording pill shows "Transcribing · \<model\>", "Lagging" or "Will finish after the meeting" | No audio leaves the machine, no account, no GPU. The model is a file the user downloads once and can inspect or delete; which one runs is decided by the hardware profile and shown with its reasoning in Settings. How Granola transcribes was not observed beyond the status label and its cloud-service nature; Minutes accepts the accuracy a small CPU model gives in exchange for privacy and offline use, and says so in `docs/limitations.md`. The conventional Windows recognizer remains as an optional engine. |
| "My notes" / "Enhanced" tabs; "Enhancing notes", "Generate notes" | One editor (TipTap) plus a **Suggestions** side panel grouped into Action items, Decisions, Deadlines, Open questions, References, Topics | Minutes has no generative AI, so there is no rewritten "enhanced" note. Suggestions are produced by rule-based extraction (`src/shared/text/extract.ts`) and every suggestion carries the verbatim sentence it came from. The note is never rewritten. |
| "Write notes…" placeholder | Same placeholder text in the editor | A two-word placeholder is generic UI copy; kept for familiarity. |
| Meeting list grouped by date with a "Today" header and count | Note list grouped by day (Today, Yesterday, weekday names, then dates); a "Pinned" group sits above; counts are shown per view in the sidebar rather than per day group | Grouping is driven by `dayGroupLabel` in `src/renderer/src/lib/format.ts`. |
| "Recent meetings" with "Jim, Michaela +5" attendees | "Recent" view (last 30 days) and attendee summary via `attendeeSummary(attendees, 3)` in the note header | Same information, independently written. |
| Inline-edited title | Inline title textarea in the note header | Same behaviour. |
| Transcript as "Me"/"Them" bubbles with timestamps | Transcript panel rows labelled "Me" (microphone channel) and "Them" (system-audio channel), with timestamps; imported transcripts keep the speaker prefix from the file instead | The labels are derived from the capture channel, not from speaker identification. Minutes has no diarization. |
| Recording pill with live green level bars, opens transcript, detaches when unfocused | Pill in the note header with five live level bars from microphone RMS, a system-audio activity dot, elapsed time, pause and stop; clicking opens the transcript panel | No detached floating window. The tray icon changes while recording instead. |
| Auto-start on meeting; auto-stop after ~15 min silence | No auto-start. "Auto-stop after silence" setting (Off, 5, 10, 15, 30, 60 minutes; default 15) enforced in the main process once a recording is older than one minute | Auto-start would need to watch other applications; Minutes only reacts to the user, the tray, a global shortcut or a calendar-created note. |
| "Ask anything" during meeting; Granola Chat | **Ask your notes** (Ctrl+J): deterministic evidence retrieval that classifies the question into an intent (deadline, assignment, decision, topic, mention, generic), searches FTS5 and returns ranked passages with an explanation of how the match was made | Returns passages, never a generated answer. See `src/shared/text/ask.ts` and `SearchRepo.ask`. |
| "List actions", "Write follow-up email" quick actions | Action items appear in Suggestions; export to Markdown or plain text includes the surviving suggestions | No email drafting; there is nothing to generate text with. |
| "Your Brief" pre-meeting | Upcoming calendar events in the sidebar (next few, from ICS feeds); clicking one creates a note pre-filled with title, time and attendees | No summary of past context is generated. |
| "Share notes" with participants | Export to `.md` / `.txt`, transcript to `.txt` / `.srt` / `.vtt` / `.md`, "Export all notes" to a folder, copy to clipboard | Single-user, no sharing service. |
| Calendar notification with join button | Sidebar "Upcoming" section only; no notifications, no join button | Minutes reads ICS feeds; it does not know meeting links beyond what the event description contains. |
| Zoom / Meet / Teams / Huddles / in-person | Anything audible through the system output on Windows (WASAPI loopback via `getDisplayMedia` with `audio: 'loopback'`), plus the microphone | Application-agnostic because capture is at the OS level; no per-app integration. |
| macOS, Windows, iOS, Android | Windows is the supported platform for recording, transcription and updates; notes, search and the editor run wherever Electron runs | See `docs/limitations.md`. |
| Free tier with 30-day history limit | Free, MIT-licensed, no history limit; the "Recent" view happens to show 30 days but all notes are kept | Trash is purged after 30 days; nothing else expires. |
| Cmd/Ctrl+J chat, Cmd/Ctrl+, settings, Cmd/Ctrl+S sidebar, Cmd/Ctrl+R refresh | Ctrl+J Ask your notes, Ctrl+, settings, Ctrl+\ toggle sidebar, Ctrl+S save now, no refresh shortcut (nothing to refresh from a server) | Ctrl+S is kept for "save now" because that is what users expect from it on Windows. All shortcuts are rebindable in Settings. |
| Templates via "/" | Not implemented | The editor offers headings, lists, checklists, quotes, code and links through the toolbar and standard TipTap keyboard shortcuts. |
| Dark mode | System / Light / Dark setting | Same. |
| Offline read/edit | Everything works offline once a speech model is installed; the only network calls are the one-time model download the user requests, user-added ICS feeds and the optional update check | Minutes is offline-first rather than offline-tolerant: there is no server to sync with, and transcription itself never goes online. |
| "Personal jargon" vocabulary | "Custom vocabulary" in Settings > Transcription, passed to whisper.cpp as the prompt of each chunk (and, for the optional Windows recognizer, as a low-weight `Choices` grammar) | Biases spelling of names and jargon; it does not retrain anything. |
| CSV export from profile | Not implemented | Exports are per-note or all-notes Markdown. |
| Cloud sync and accounts | None. One SQLite file (`minutes.sqlite`) with daily automatic backups kept to the last ten, manual backup and restore | Local data is the point of the project. |
| Calendar OAuth (Google / Microsoft) | ICS feed URLs (Google "secret address", Outlook "publish calendar", webcal links) and local `.ics` files, refreshed every 30 minutes | No OAuth client, no tokens, no vendor SDKs. |
| Low-chroma paper-like palette, green live accent | Warm neutral "paper" palette defined in `tokens.css`; a single accent used for recording state, focus rings and the one primary action | Values chosen independently (`docs/brand.md`); the only Granola colours we know are the two website metadata values and they were not used. |

## Why the substitutions are honest rather than lesser

Transcription is the one place where Minutes also uses a neural model, and
it is the one place where a deterministic substitute would be dishonest about
quality: it runs an open-source model locally, CPU-only, with the model file,
the hardware check and the chosen model all visible to the user. The three
features Granola builds on a language model — enhanced notes, chat, and
follow-up generation — are replaced by mechanisms that can be inspected and
tested: regex and cue tables for suggestions, FTS5 with bm25 plus a fixed
intent table for Ask, and exports instead of generated prose. They do less,
and they say so in the UI (every suggestion shows its source sentence; every
Ask result explains which intent and terms were used). That is the trade the
project makes deliberately.
