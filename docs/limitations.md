# Known limitations

This is the list of things Minutes does not do, does imperfectly, or has not
yet proved on real hardware. It is kept deliberately blunt so that nobody is
surprised later.

## Transcription

Accuracy. The engine is whisper.cpp running OpenAI's Whisper models on the
CPU. Which model runs depends on the machine: the Lightweight profile uses the
tiny models, Balanced the base models, High accuracy the small models; medium
and larger are only used when pinned explicitly and are not suitable for live
use on a CPU. Tiny and base produce a readable, punctuated draft in a quiet
room with a close microphone; they are not a verbatim record, and far-field
microphones, cross-talk, noise and strong accents degrade them noticeably.
Small is better; whether it should be the Balanced default on 16 GB laptops is
still to be settled by `docs/benchmarks.md`.

Hallucination. Whisper can emit plausible text for audio that contains no
speech (hum, music, long silence). Silent windows are skipped by RMS before
they reach the model (floor −42 dBFS, or 2 × the running noise floor) and
non-speech tokens are suppressed. Segments the model itself flags as
no-speech (`no_speech_prob > 0.6` with `avg_logprob < −1.0`, the reference
heuristic) are dropped, as are Whisper's stock silence phrases ("Thanks for
watching.", "Subtitles by …", a lone "you") when `no_speech_prob > 0.3`. The
first Windows installation produced exactly such a segment from 90 s of office
noise before these filters existed. Two further failure modes seen on the same machine with
background speech and noise are handled in `segment-filter.ts`: a window
that is one phrase repeated three or more times ("I'm tired. I'm tired. I'm
tired…") is dropped, and a window whose text is a verbatim echo of the context
fed from the previous window ("I think it might have to be better." returned
unchanged for eight consecutive windows) is dropped and the context is cleared
so the loop ends. Invented phrases on noisy stretches remain possible, a
genuine "thank you" said over heavy noise can be lost, and a speaker who really
does repeat a sentence three times verbatim will see it once. The
confidence value stored with each segment is derived from the model's token
probabilities and is a hint only.

Languages. One language setting applies to the whole recording. With a
multilingual model, "Automatic" sends `language=auto` and whisper.cpp detects
the language per window, which can flip between windows in mixed-language
meetings; set the language explicitly when it is known. English-only (`.en`)
models transcribe English regardless of the setting.

Speaker separation. There is no diarization. The only separation is by audio
channel: "Me" is the microphone, "Them" is the system-audio loopback. Two
remote participants cannot be told apart, and in a room with several people on
one microphone everything is "Me".

Latency. Audio is cut into chunks at pauses (at least 1 s of trailing
silence after at least 3 s of audio) with a hard cut at the profile's chunk
length (12 s lightweight, 10 s balanced and high-accuracy), and each chunk is
transcribed after it closes, one at a time. Text therefore appears one chunk
plus processing time behind speech: a few seconds on a fast machine, tens of
seconds on a slow one.

Keeping up. When the backlog exceeds twice the chunk reference or processing
runs slower than real time the pill shows "Lagging"; when the backlog exceeds
60 s or processing is more than 1.5× slower than real time, live
transcription stops pulling chunks and the remaining audio is transcribed as a
background job after the meeting ("Will finish after the meeting"). The model
is never switched during a recording. No audio is lost in either case, but
the transcript for that stretch is not visible until the job runs.

Memory planning is an estimate. Every model's memory figure in the catalog is
currently an estimate (`memoryMeasured: false`); the 64 MB per extra thread
and 150 MB job overhead are too. The plan compares them against available
memory minus a safety margin at load time; it is not a reservation, and
another application growing afterwards can still push the worker into swap or
an out-of-memory exit. That exit is contained (restart up to twice per
session, then deferral), not prevented.

Hardware detection on Windows. CPU feature flags cannot be read from Node on
Windows, so AVX2 is unknown until the worker has started once and reported
which CPU variant it loaded. Until then the recommendation may be Balanced on
a machine that should be Lightweight. The profile the user picked is never
changed automatically.

Background jobs. One job runs at a time, in creation order, and only when no
live session is active. Each job transcribes windows of at most 30 s cut at
quiet points; segment timestamps are exact to the window, and a word spanning
a window boundary can be split or lost. Progress is saved after every window,
so an interrupted job resumes from the next window, not from zero.

Unmeasured performance. No speed or memory figure is claimed for any model on
any Windows machine until `docs/benchmarks.md` reports it. The integration
tests prove the pipeline on a Linux VM with the tiny.en-q5_1 model only.

Not yet run on Windows hardware. The whisper subsystem was written and tested
on Linux (unit tests with a fake engine; integration tests against the real
Linux runtime). The Windows runtime was cross-compiled and smoke-run under
wine, but no recording has yet been transcribed on a Windows machine. The
on-device checklist in `docs/testing.md` lists what to confirm first.

Custom vocabulary. Terms are included in the Whisper prompt of every chunk,
ahead of the previous chunk's text. This biases spellings; it does not add
words the model cannot hear. Prompts are truncated to their last 600
characters, so a very long list crowds out the rolling context. The
Settings help ("names and jargon the engine should prefer") describes the
intent, not this per-chunk behaviour.

Optional Windows recognizer. The `System.Speech` engine remains selectable.
Its limits are the old ones: HMM/GMM accuracy well below whisper, only the
cultures with an installed Windows speech pack, minimal punctuation, numbers as
words, no background jobs or deferral, and no availability where Windows
PowerShell is blocked by AppLocker/WDAC. Importing SRT/VTT/TXT transcripts
works regardless of engine.

## Recording and system audio

System audio needs WASAPI loopback, which Chromium exposes on Windows 10
version 1903 and later through `getDisplayMedia` with `audio: 'loopback'`.
Earlier Windows builds fall back to microphone only, with a toast explaining
why. Chromium requires the request to carry a video source; the main process
answers with the requesting web frame itself (no screen capture, no picker)
and the renderer stops that video track immediately. Answering with audio
alone fails with `AbortError` — this is what the first Windows installation
hit (0.2.0/0.2.1), so loopback capture on a real Windows machine is verified
only from 0.2.2 onwards.

Applications that open the audio device in exclusive mode bypass the shared
mix and are not captured. Some Bluetooth audio paths (in particular headsets
switched into the hands-free/HFP profile during a call) route audio in a way
loopback does not see, or degrade the microphone to narrowband while the call
is active. Whether a given headset works has to be tried.

The microphone is captured with echo cancellation, noise suppression and
automatic gain control enabled by the browser engine; these cannot be turned
off from the UI.

The level meter in the recording pill reflects the microphone only; the
system-audio channel is shown as an activity dot.

Nothing records automatically. A recording starts from the Record button, the
tray, the global shortcut or a `captureCommand` from main; there is no
detection of a meeting starting in another application.

## Platforms

Windows 10/11 x64 is the only platform where recording with system audio,
transcription and automatic updates are supported; the shipped whisper.cpp
runtime is `win-x64` only (no 32-bit, no ARM64, no GPU build). A Linux x64
runtime is built for development and the integration tests. Notes, search,
suggestions, calendar, export and backup work wherever Electron runs, and
microphone-only recording may work elsewhere, but no macOS or Linux end-user
behaviour is tested or claimed. The window chrome, tray icon and paths are
written for Windows. See `docs/hardware-requirements.md`.

## Installer and updates

The installer is unsigned. SmartScreen shows "Windows protected your PC" on
first run and on every update install. The only fix is an Authenticode
certificate; see `docs/updates-and-release.md`.

The updater is active only in packaged builds (`app.isPackaged`); development
builds report "disabled". It requires a public GitHub Releases page containing
`latest.yml`, the installer and its blockmap. `electron-builder.yml` points
`publish` at owner `dexterity-design`, repo `minutes`; change both to your
own repository before you cut a release, or installed copies will look for
updates in the wrong place. Only one channel (`latest`) and one architecture
(x64) are built. The installer must carry the ≈ 41 MB whisper runtime
(`resources/whisper/win-x64`); see `docs/updates-and-release.md`.

## Calendar

Calendars are read from ICS feeds (URLs or local files), not through Google or
Microsoft OAuth. There is no two-way sync, no event creation and no join
button; the sidebar simply shows upcoming events and creates a note for one on
request.

Feeds are refreshed every 30 minutes while any URL source exists and the
machine is online, and on demand. Each refresh keeps events from 7 days ago to
60 days ahead; recurring events are expanded within that window by the
parser in `src/shared/ics.ts`, which handles FREQ, INTERVAL, COUNT, UNTIL,
BYDAY, BYMONTHDAY and EXDATE as they appear in Google and Outlook exports,
with a hard ceiling on generated instances; it is not a complete RRULE
implementation.

Secret feed URLs are stored in plain text in the `calendar_sources` table of
`minutes.sqlite`. Anyone who can read that file, or a backup of it, can fetch
your calendar. Treat the database and backups folders as sensitive. (The
diagnostics export does not include calendar sources.)

Feeds larger than 10 MB or slower than 20 s are rejected; the previous events
are kept until a refresh succeeds.

## Suggestions and Ask

Both are English-language, pattern-based heuristics. They are deterministic
and inspectable, and they are only as good as their cue tables.

Suggestions (`src/shared/text/extract.ts`) work sentence by sentence. A
sentence becomes at most one of: a decision (cue words such as "we decided",
"agreed", "approved", "go with", "sign off", "proceed with"), a deadline (a
date mention that resolves to a day plus a deadline cue such as "by", "before",
"due", "EOD" or an action cue), an action (commitment phrases like "will",
"need to", "should"; labels like "Action:", "TODO", "[ ]"; sentence-initial
imperatives such as "Send", "Update", "Schedule"; requests "can you", "please";
"follow up"; `@mentions`; "Name to verb"; ownership words), or a question (ends
with "?" or starts with an interrogative). Weak actions are dropped unless
they carry a person name or an explicit cue. References are regex matches for
URLs, email addresses, ticket ids like `ABC-123`, file names with known
extensions, currency amounts and quoted phrases. Topics come from a TextRank
style ranking of phrases, and a topic is only kept if its words appear in
order in some sentence. Scores are ratios of matched rules, not probabilities.
Sentences over 60 words are ignored for action/decision/deadline. Person-name
detection is a capitalisation heuristic with a stop list; it will miss
lower-case names and flag capitalised common words.

Ask (`src/shared/text/ask.ts`) classifies the question into one of six
intents by cue regexes (deadline: "when", "due", "deadline", "timeline";
assignment: "who", "assigned", "owner", "tasks"; decision: "decided", "agreed",
"outcome", "approved"; topic: "what did we discuss", "summary"; mention:
"where was X mentioned"; otherwise generic), strips question scaffolding and
stopwords to get content terms, expands them with Porter-style stems and a
small fixed synonym list per intent, and runs an FTS5 prefix query. Passages
are scored by stem overlap, term coverage and intent cue counts, with a mild
penalty for long passages. When the question has no content terms ("what
deadlines were mentioned?") recent passages are scanned for the intent's cues
instead. The result is a ranked list of passages and an explanation. It never
answers, summarises or infers; a question whose words do not appear in the
notes returns nothing.

## Search

Search is SQLite FTS5 with the `unicode61` tokenizer and diacritic removal.
Each word is matched as a prefix, quoted strings are matched as phrases, and
results are ranked by bm25 with title weighted higher than body. There is no
stemming in the index, no fuzzy matching, no synonyms beyond the Ask intent
table, and no cross-language support. Search covers notes, transcript
segments and suggestions; archived notes are excluded unless the filter is
set. Very long notes are indexed whole; an FTS syntax error from pathological
input is treated as no results.

## Data

Single user, single machine, no sync. Moving to another machine means copying
`%APPDATA%\Minutes` or restoring a backup.

Trash is purged on startup for notes deleted more than 30 days ago. Permanent
deletion also removes kept recordings for that note.

The automatic backup runs at most once per day on launch, only when at least
one note exists, and keeps the newest ten automatic backups (files named
`minutes-backup-auto-<timestamp>.sqlite`). Manual backups and the
`before-restore` safety copies are never pruned, so the backups folder grows
until you clean it up yourself.

Nothing is encrypted at rest. See `docs/security.md`.

## Performance

Only spot measurements exist, taken in a Linux VM with software rendering
(no GPU), so real Windows machines should do at least as well. A 20,000-word
note measured roughly 24 ms from keystroke to paint, against 16 ms for a bare
`contenteditable` in the same environment; the difference is the editor
extensions and the text projection. Searching a 300-note library took about
70 ms per query. The editor keeps the whole ProseMirror document in memory and
autosaves the full JSON and text projection on each change (debounced
600 ms); IPC payload limits are 20 MB of JSON and 10 MB of text per note,
50 MB per transcript import. Search is limited to 500 results per query. No
numbers are claimed beyond those two measurements. Transcription speed and
memory are reported separately in `docs/benchmarks.md`.

## Editor

No slash-command templates, no tables, no images or attachments, no
collaborative editing. Links open in the system browser only via the link
toolbar; links are not clickable inline (`openOnClick: false`).
