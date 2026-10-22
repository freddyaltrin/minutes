<#
.SYNOPSIS
    Minutes — local speech recognition worker built on the Windows desktop
    recognizer (SAPI 5.x via .NET System.Speech.Recognition).

.DESCRIPTION
    This is a long-running worker process. The Electron main process starts it,
    then talks to it over stdin/stdout using JSON Lines (one JSON object per
    line, UTF-8, no BOM).

    WHAT THIS IS
      * The conventional, HMM/GMM-based desktop recognizer that ships with
        Windows ("Windows Speech Recognition"). It is exposed to .NET through
        the System.Speech assembly, which is part of the .NET Framework.
      * Fully offline. Nothing leaves the machine. No cloud service, no neural
        network model, no third-party download.

    WHAT THIS IS NOT
      * It is not a modern neural speech recognizer. Accuracy is noticeably
        lower than Whisper-class systems, especially with far-field
        microphones, accents the Windows profile was not trained on, cross-talk
        and background noise. Expect a usable-but-imperfect transcript that a
        human will tidy up.

    REQUIREMENTS
      * Windows 10 or Windows 11 (desktop editions).
      * Windows PowerShell 5.1 (C:\Windows\System32\WindowsPowerShell\v1.0\
        powershell.exe). PowerShell 7 / pwsh.exe runs on .NET (Core) which does
        NOT include System.Speech, so this script must be launched with the
        built-in Windows PowerShell 5.1.
      * .NET Framework 4.x (present on every supported Windows 10/11 build).
      * At least one Windows speech recognizer language pack. Install under
        Settings > Time & Language > Language & region > (language) > Language
        options > Speech recognition. "Speech" under Time & Language must list
        the language as well. Without a recognizer pack, InstalledRecognizers()
        is empty and this worker reports ok:false from "probe".
      * The recognizer uses the current user's Windows speech profile. Training
        it (Control Panel > Speech Recognition > Train your computer to better
        understand you) measurably improves results.

    AUDIO INPUT
      * Each "recognize" command names a finished WAV file: 16 kHz, 16-bit,
        mono, PCM. The file must be completely written before the command is
        sent; the worker reads it with SetInputToWaveFile.

    PROTOCOL (stdin -> worker)
      {"cmd":"probe"}
      {"cmd":"init","culture":"en-US","vocabulary":["Dexterity","Petroka"]}
      {"cmd":"recognize","path":"C:\\...\\chunk-000001.wav","offsetMs":123456,"channel":"mix"}
      {"cmd":"shutdown"}

    PROTOCOL (worker -> stdout)
      {"type":"probe","ok":true,"recognizers":[{"id":"...","name":"...","culture":"en-US"}],"dotnet":"4.0.30319.42000"}
      {"type":"probe","ok":false,"error":"..."}
      {"type":"ready","culture":"en-US","recognizer":"...","vocabularyLoaded":true}
      {"type":"segment","text":"...","confidence":0.87,"startMs":123456,"endMs":125000,"channel":"mix","offsetMs":123456,"lowConfidence":false,"grammar":"dictation"}
      {"type":"done","path":"C:\\...\\chunk-000001.wav","results":3}
      {"type":"error","message":"...","where":"recognize"}
      {"type":"log","level":"info","message":"..."}
      {"type":"bye"}

    Every exception is caught and reported as an "error" line; the worker never
    exits silently. Diagnostic chatter goes to stderr, never to stdout.
#>

#Requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# I/O: UTF-8 without BOM on both directions, explicit streams so that nothing
# PowerShell does with the console (colouring, progress bars) can corrupt the
# JSON channel.
# ---------------------------------------------------------------------------
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }
try { [Console]::InputEncoding = $script:Utf8NoBom } catch { }

$script:Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $script:Utf8NoBom)
$script:Out.AutoFlush = $true
$script:Out.NewLine = "`n"

$script:Err = New-Object System.IO.StreamWriter([Console]::OpenStandardError(), $script:Utf8NoBom)
$script:Err.AutoFlush = $true
$script:Err.NewLine = "`n"

$script:In = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $script:Utf8NoBom)

# Worker state
$script:Engine = $null
$script:EngineCulture = $null
$script:LowConfidenceThreshold = 0.3
$script:CompletedEventId = 'MinutesSapiRecognizeCompleted'

function Send-Line {
    param([Parameter(Mandatory = $true)] $Object)
    try {
        $json = ConvertTo-Json -InputObject $Object -Compress -Depth 8
        # ConvertTo-Json never emits a newline with -Compress, but be defensive:
        $json = $json -replace "`r", '' -replace "`n", ' '
        $script:Out.WriteLine($json)
    } catch {
        try { $script:Err.WriteLine("Send-Line failed: $($_.Exception.Message)") } catch { }
    }
}

function Send-Error {
    param([string] $Where, [string] $Message)
    Send-Line ([ordered]@{ type = 'error'; where = $Where; message = $Message })
}

function Send-Log {
    param([string] $Level, [string] $Message)
    Send-Line ([ordered]@{ type = 'log'; level = $Level; message = $Message })
}

function Write-Diag {
    param([string] $Message)
    try { $script:Err.WriteLine("[recognizer.ps1] $Message") } catch { }
}

function Get-ExceptionText {
    param($ErrorRecord)
    $ex = $null
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ex = $ErrorRecord.Exception } else { $ex = $ErrorRecord }
    $parts = @()
    $depth = 0
    while ($null -ne $ex -and $depth -lt 5) {
        $parts += ("{0}: {1}" -f $ex.GetType().Name, $ex.Message)
        $ex = $ex.InnerException
        $depth++
    }
    return ($parts -join ' <- ')
}

function Get-DotNetVersion {
    try {
        $release = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction Stop).Release
        return ("CLR {0} (release {1})" -f [System.Environment]::Version.ToString(), $release)
    } catch {
        return [System.Environment]::Version.ToString()
    }
}

function Import-SpeechAssembly {
    # Idempotent. Throws if System.Speech is unavailable (pwsh 7 / .NET Core).
    if (-not ('System.Speech.Recognition.SpeechRecognitionEngine' -as [type])) {
        Add-Type -AssemblyName System.Speech -ErrorAction Stop
    }
}

# ---------------------------------------------------------------------------
# probe
# ---------------------------------------------------------------------------
function Invoke-Probe {
    try {
        if ($PSVersionTable.PSEdition -and $PSVersionTable.PSEdition -ne 'Desktop') {
            Send-Line ([ordered]@{
                type = 'probe'; ok = $false
                error = "This worker must run under Windows PowerShell 5.1 (Desktop edition); current edition is '$($PSVersionTable.PSEdition)'. PowerShell 7 does not include System.Speech."
            })
            return
        }
        Import-SpeechAssembly
        $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
        $list = @()
        foreach ($r in $installed) {
            $cultureName = ''
            try { if ($null -ne $r.Culture) { $cultureName = $r.Culture.Name } } catch { }
            $list += [ordered]@{
                id = [string]$r.Id
                name = [string]$r.Name
                culture = $cultureName
                description = [string]$r.Description
            }
        }
        if ($list.Count -eq 0) {
            Send-Line ([ordered]@{
                type = 'probe'; ok = $false
                recognizers = @()
                dotnet = (Get-DotNetVersion)
                error = 'No Windows speech recognizer is installed. Install a speech language pack under Settings > Time & Language > Speech.'
            })
            return
        }
        Send-Line ([ordered]@{
            type = 'probe'; ok = $true
            recognizers = @($list)
            dotnet = (Get-DotNetVersion)
            powershell = $PSVersionTable.PSVersion.ToString()
        })
    } catch {
        Send-Line ([ordered]@{ type = 'probe'; ok = $false; error = (Get-ExceptionText $_) })
    }
}

# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------
function Build-VocabularyGrammar {
    param(
        [string[]] $Words,
        [System.Globalization.CultureInfo] $Culture
    )
    # Choices = list of alternatives. We wrap it as
    #   [dictation]{0,1} <choice> [dictation]{0,1}
    # so that a custom name can be recognized in the middle of free speech.
    # If the hybrid builder is rejected by the engine, we fall back to a plain
    # Choices grammar (recognizes the name only when spoken on its own).
    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($w in $Words) {
        $t = ([string]$w).Trim()
        if ($t.Length -eq 0) { continue }
        $choices.Add([string[]]@($t))
    }

    $builder = New-Object System.Speech.Recognition.GrammarBuilder
    $builder.Culture = $Culture
    try {
        $pre = New-Object System.Speech.Recognition.GrammarBuilder
        $pre.Culture = $Culture
        $pre.AppendDictation()
        $post = New-Object System.Speech.Recognition.GrammarBuilder
        $post.Culture = $Culture
        $post.AppendDictation()
        $builder.Append($pre, 0, 1)
        $builder.Append($choices)
        $builder.Append($post, 0, 1)
    } catch {
        Write-Diag ("hybrid vocabulary grammar failed, falling back to plain Choices: " + (Get-ExceptionText $_))
        $builder = New-Object System.Speech.Recognition.GrammarBuilder
        $builder.Culture = $Culture
        $builder.Append($choices)
    }
    $grammar = New-Object System.Speech.Recognition.Grammar($builder)
    $grammar.Name = 'vocabulary'
    # Low weight: the dictation grammar should still win for ordinary speech.
    $grammar.Weight = [single]0.5
    $grammar.Priority = 0
    return $grammar
}

function Invoke-Init {
    param($Msg)
    try {
        Import-SpeechAssembly

        if ($null -ne $script:Engine) {
            Write-Diag 'init called twice; disposing previous engine'
            Dispose-Engine
        }

        $requested = $null
        if ($Msg.PSObject.Properties['culture'] -and $null -ne $Msg.culture -and ([string]$Msg.culture).Trim().Length -gt 0) {
            $requested = ([string]$Msg.culture).Trim()
        }

        $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
        if ($installed.Count -eq 0) {
            throw 'No Windows speech recognizer is installed (Settings > Time & Language > Speech).'
        }

        $info = $null
        if ($null -ne $requested) {
            foreach ($r in $installed) {
                if ($null -ne $r.Culture -and $r.Culture.Name -ieq $requested) { $info = $r; break }
            }
            if ($null -eq $info) {
                # Try a language-only match, e.g. "en" vs "en-GB".
                $lang = $requested.Split('-')[0]
                foreach ($r in $installed) {
                    if ($null -ne $r.Culture -and $r.Culture.TwoLetterISOLanguageName -ieq $lang) { $info = $r; break }
                }
            }
            if ($null -eq $info) {
                $avail = ($installed | ForEach-Object { $_.Culture.Name }) -join ', '
                throw "No recognizer installed for culture '$requested'. Installed: $avail"
            }
        } else {
            $info = $installed[0]
        }

        $culture = $info.Culture
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
        $script:Engine = $engine
        $script:EngineCulture = $culture

        # Timeouts. Our chunks are at most ~25 s; a generous initial-silence
        # timeout means Recognize() returning $null reliably signals end of
        # input rather than "leading silence".
        try { $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(60) } catch { Write-Diag "InitialSilenceTimeout: $(Get-ExceptionText $_)" }
        try { $engine.BabbleTimeout = [TimeSpan]::Zero } catch { Write-Diag "BabbleTimeout: $(Get-ExceptionText $_)" }
        try { $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(400) } catch { Write-Diag "EndSilenceTimeout: $(Get-ExceptionText $_)" }
        try { $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(800) } catch { Write-Diag "EndSilenceTimeoutAmbiguous: $(Get-ExceptionText $_)" }

        # Do not let file-based recognition permanently alter the user's
        # speech profile. Setting names are recognizer-specific; failures are
        # harmless and only logged.
        foreach ($setting in @(@('PersistedBackgroundAdaptation', 0))) {
            try { [void]$engine.UpdateRecognizerSetting([string]$setting[0], [int]$setting[1]) }
            catch { Write-Diag ("UpdateRecognizerSetting {0}: {1}" -f $setting[0], (Get-ExceptionText $_)) }
        }

        # Grammars
        $dictation = New-Object System.Speech.Recognition.DictationGrammar
        $dictation.Name = 'dictation'
        $engine.LoadGrammar($dictation)

        $vocabularyLoaded = $false
        $words = @()
        if ($Msg.PSObject.Properties['vocabulary'] -and $null -ne $Msg.vocabulary) {
            $words = @($Msg.vocabulary | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -Unique)
        }
        if ($words.Count -gt 0) {
            try {
                $vg = Build-VocabularyGrammar -Words $words -Culture $culture
                $engine.LoadGrammar($vg)
                $vocabularyLoaded = $true
            } catch {
                # Vocabulary is a nicety; dictation still works without it.
                Send-Log 'warn' ("Custom vocabulary grammar could not be loaded: " + (Get-ExceptionText $_))
            }
        }

        # RecognizeCompleted fires when an input stream is exhausted. We queue
        # the event and inspect it after each Recognize() call.
        try { Unregister-Event -SourceIdentifier $script:CompletedEventId -ErrorAction SilentlyContinue } catch { }
        try {
            [void](Register-ObjectEvent -InputObject $engine -EventName RecognizeCompleted -SourceIdentifier $script:CompletedEventId)
        } catch {
            Write-Diag ("Register-ObjectEvent RecognizeCompleted: " + (Get-ExceptionText $_))
        }

        Send-Line ([ordered]@{
            type = 'ready'
            culture = $culture.Name
            recognizer = [string]$info.Name
            recognizerId = [string]$info.Id
            vocabularyLoaded = $vocabularyLoaded
            vocabularyCount = $words.Count
        })
    } catch {
        Send-Error 'init' (Get-ExceptionText $_)
    }
}

# ---------------------------------------------------------------------------
# recognize
# ---------------------------------------------------------------------------
function Get-WavDurationMs {
    param([string] $Path)
    # Minimal RIFF/WAVE parse: locate "fmt " and "data" chunks.
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $br = New-Object System.IO.BinaryReader($fs)
            $riff = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
            [void]$br.ReadUInt32()
            $wave = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
            if ($riff -ne 'RIFF' -or $wave -ne 'WAVE') { return -1 }
            $sampleRate = 0; $channels = 0; $bits = 0; $dataBytes = 0
            while ($fs.Position + 8 -le $fs.Length) {
                $id = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
                $size = $br.ReadUInt32()
                if ($id -eq 'fmt ') {
                    [void]$br.ReadUInt16()          # format tag
                    $channels = $br.ReadUInt16()
                    $sampleRate = $br.ReadUInt32()
                    [void]$br.ReadUInt32()          # byte rate
                    [void]$br.ReadUInt16()          # block align
                    $bits = $br.ReadUInt16()
                    if ($size -gt 16) { $fs.Seek($size - 16, [System.IO.SeekOrigin]::Current) | Out-Null }
                } elseif ($id -eq 'data') {
                    $dataBytes = $size
                    break
                } else {
                    $fs.Seek($size + ($size % 2), [System.IO.SeekOrigin]::Current) | Out-Null
                }
            }
            if ($sampleRate -le 0 -or $channels -le 0 -or $bits -le 0) { return -1 }
            $bytesPerSec = $sampleRate * $channels * ($bits / 8)
            return [double]$dataBytes * 1000.0 / $bytesPerSec
        } finally { $fs.Dispose() }
    } catch {
        Write-Diag ("WAV header parse failed: " + (Get-ExceptionText $_))
        return -1
    }
}

function Test-InputStreamEnded {
    # Drain queued RecognizeCompleted events; return $true if any reports the
    # stream ended (or an error, which also means we must stop).
    $ended = $false
    try {
        $events = @(Get-Event -SourceIdentifier $script:CompletedEventId -ErrorAction SilentlyContinue)
        foreach ($ev in $events) {
            try {
                $evArgs = $ev.SourceEventArgs
                if ($null -ne $evArgs) {
                    if ($evArgs.InputStreamEnded) { $ended = $true }
                    if ($null -ne $evArgs.Error) { Write-Diag ("RecognizeCompleted.Error: " + $evArgs.Error.Message); $ended = $true }
                    if ($evArgs.Cancelled) { $ended = $true }
                }
            } catch { }
            try { Remove-Event -EventIdentifier $ev.EventIdentifier -ErrorAction SilentlyContinue } catch { }
        }
    } catch { }
    return $ended
}

function Invoke-Recognize {
    param($Msg)
    $path = $null
    try {
        if ($null -eq $script:Engine) { throw 'Engine not initialised; send "init" first.' }
        if (-not $Msg.PSObject.Properties['path'] -or [string]::IsNullOrWhiteSpace([string]$Msg.path)) { throw 'recognize: "path" is required' }
        $path = [string]$Msg.path
        if (-not (Test-Path -LiteralPath $path)) { throw "recognize: file not found: $path" }

        $offsetMs = 0.0
        if ($Msg.PSObject.Properties['offsetMs'] -and $null -ne $Msg.offsetMs) { $offsetMs = [double]$Msg.offsetMs }
        $channel = 'mix'
        if ($Msg.PSObject.Properties['channel'] -and $null -ne $Msg.channel) { $channel = [string]$Msg.channel }

        $engine = $script:Engine
        $fileDurationMs = Get-WavDurationMs -Path $path

        # Clear stale completion events from a previous file.
        [void](Test-InputStreamEnded)

        $engine.SetInputToWaveFile($path)

        $count = 0
        $nullStreak = 0
        $lastPosMs = -1.0
        $maxIterations = 10000

        for ($i = 0; $i -lt $maxIterations; $i++) {
            $result = $null
            try {
                $result = $engine.Recognize()
            } catch {
                # InvalidOperationException is thrown e.g. when the input has
                # been exhausted/unset; anything else is reported and ends the file.
                Send-Error 'recognize.loop' (Get-ExceptionText $_)
                break
            }

            if ($null -eq $result) {
                $nullStreak++
                if (Test-InputStreamEnded) { break }
                $posMs = -1.0
                try { $posMs = $engine.AudioPosition.TotalMilliseconds } catch { }
                $reachedEnd = ($fileDurationMs -lt 0) -or ($posMs -lt 0) -or ($posMs -ge ($fileDurationMs - 250.0))
                $noProgress = ($posMs -le $lastPosMs)
                $lastPosMs = $posMs
                if ($reachedEnd -or $noProgress -or $nullStreak -ge 4) { break }
                continue
            }
            $nullStreak = 0

            $text = ''
            try { $text = [string]$result.Text } catch { }
            $confidence = 0.0
            try { $confidence = [double]$result.Confidence } catch { }

            $startMs = $offsetMs
            $endMs = $null
            $hasAudio = $false
            try {
                if ($null -ne $result.Audio) {
                    $hasAudio = $true
                    $startMs = $offsetMs + $result.Audio.AudioPosition.TotalMilliseconds
                    $endMs = $startMs + $result.Audio.Duration.TotalMilliseconds
                }
            } catch { $hasAudio = $false }
            if (-not $hasAudio) {
                # Fall back to the engine's stream position (end of utterance).
                try {
                    $posMs = $engine.AudioPosition.TotalMilliseconds
                    $endMs = $offsetMs + $posMs
                    if ($lastPosMs -ge 0) { $startMs = $offsetMs + $lastPosMs } else { $startMs = $offsetMs }
                } catch { $endMs = $startMs }
            }
            try { $lastPosMs = $engine.AudioPosition.TotalMilliseconds } catch { }

            $grammarName = ''
            try { if ($null -ne $result.Grammar) { $grammarName = [string]$result.Grammar.Name } } catch { }

            if ($text.Trim().Length -gt 0) {
                $count++
                Send-Line ([ordered]@{
                    type = 'segment'
                    text = $text.Trim()
                    confidence = [Math]::Round($confidence, 4)
                    startMs = [Math]::Round($startMs)
                    endMs = $(if ($null -ne $endMs) { [Math]::Round($endMs) } else { [Math]::Round($startMs) })
                    channel = $channel
                    offsetMs = [Math]::Round($offsetMs)
                    lowConfidence = ($confidence -lt $script:LowConfidenceThreshold)
                    grammar = $grammarName
                })
            }
        }

        Send-Line ([ordered]@{ type = 'done'; path = $path; results = $count; durationMs = [Math]::Round($fileDurationMs) })
    } catch {
        Send-Error 'recognize' (Get-ExceptionText $_)
        # Still send "done" so the Node side can advance its queue.
        Send-Line ([ordered]@{ type = 'done'; path = $path; results = 0; failed = $true })
    } finally {
        try { if ($null -ne $script:Engine) { $script:Engine.SetInputToNull() } } catch { }
    }
}

# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------
function Dispose-Engine {
    try { Unregister-Event -SourceIdentifier $script:CompletedEventId -ErrorAction SilentlyContinue } catch { }
    if ($null -ne $script:Engine) {
        try { $script:Engine.RecognizeAsyncCancel() } catch { }
        try { $script:Engine.SetInputToNull() } catch { }
        try { $script:Engine.UnloadAllGrammars() } catch { }
        try { $script:Engine.Dispose() } catch { }
        $script:Engine = $null
    }
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
Send-Log 'info' ("worker started; PowerShell {0} {1}; PID {2}" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition, $PID)

$exitCode = 0
try {
    while ($true) {
        $line = $null
        try {
            $line = $script:In.ReadLine()
        } catch {
            Send-Error 'stdin' (Get-ExceptionText $_)
            break
        }
        if ($null -eq $line) { break }          # stdin closed -> parent is gone
        $line = $line.Trim()
        if ($line.Length -eq 0) { continue }

        $msg = $null
        try {
            $msg = ConvertFrom-Json -InputObject $line
        } catch {
            Send-Error 'parse' ("Invalid JSON command: " + (Get-ExceptionText $_))
            continue
        }
        if ($null -eq $msg -or -not $msg.PSObject.Properties['cmd']) {
            Send-Error 'parse' 'Command object has no "cmd" field'
            continue
        }

        $cmd = [string]$msg.cmd
        try {
            switch ($cmd) {
                'probe'     { Invoke-Probe }
                'init'      { Invoke-Init -Msg $msg }
                'recognize' { Invoke-Recognize -Msg $msg }
                'ping'      { Send-Line ([ordered]@{ type = 'pong' }) }
                'shutdown'  { Dispose-Engine; Send-Line ([ordered]@{ type = 'bye' }) }
                default     { Send-Error 'dispatch' "Unknown command '$cmd'" }
            }
        } catch {
            Send-Error $cmd (Get-ExceptionText $_)
        }
        if ($cmd -eq 'shutdown') { break }
    }
} catch {
    Send-Error 'main' (Get-ExceptionText $_)
    $exitCode = 1
} finally {
    Dispose-Engine
    try { $script:Out.Flush() } catch { }
    try { $script:Err.Flush() } catch { }
}

exit $exitCode
