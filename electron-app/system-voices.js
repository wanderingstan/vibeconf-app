// system-voices.js — the OS's built-in ("out of the box") TTS voices.
//
// macOS has `say`; Windows has no `say`, but every install ships SAPI 5, which
// PowerShell reaches via System.Speech with nothing to install (#18). Both can
// render to a file, which is what the app actually needs — synthesized audio is
// played into the virtual mic, never straight to the speakers.
//
// This module is PURE (no fs / child_process / electron): it builds the command
// text and parses the output. The I/O lives in tts.js (render) and main.js
// (enumerate), so all the fiddly parsing and PowerShell quoting is unit-testable.
// See tests/system-voices.test.mjs.
//
// NOTE: mcp-server/server.js carries its own copy of the enumerate half — it is
// packaged standalone (extraResources) and cannot require() into electron-app/.
// Keep the two in sync, same as the existing WHITELISTED_MACOS_STANDARD dupe.

// Platforms whose voices can be ENUMERATED, which is not the same as platforms
// that can speak. Linux speaks via espeak-ng (tts.js `_linuxEspeak`) but is
// absent here: espeak errors on an unknown voice name rather than substituting
// like `say`/SAPI, so we never pass `-v` and the picker has nothing to offer.
// Adding Linux means parsing `espeak-ng --voices` first — #21.
const SYSTEM_VOICE_PLATFORMS = ['darwin', 'win32'];

// Quality tiers, shared by both platforms so the pickers can sort one list:
// 0 = macOS Premium, 1 = macOS Enhanced *and* every Windows SAPI voice,
// 2 = plain/legacy (macOS standard voices, which are mostly robotic).
//
// Windows voices land in tier 1 rather than 2 deliberately: David/Zira are all
// most Windows machines have, so demoting them to the picker's "lower quality"
// group would leave the main built-in group empty.
function macosTier(name) {
  if (/\(Premium\)/i.test(name)) return 0;
  if (/\(Enhanced\)/i.test(name)) return 1;
  return 2;
}

// Quality first, then English, then name — the order both voice pickers show.
function sortVoices(voices) {
  return [...voices].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const ae = a.locale.startsWith('en'), be = b.locale.startsWith('en');
    if (ae !== be) return ae ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function dedupeByName(voices) {
  const seen = new Set();
  return voices.filter((v) => (seen.has(v.name) ? false : seen.add(v.name)));
}

// Parse `say -v '?'` output → [{ name, locale, sample, tier }].
// Lines look like "Samantha  en_US  # Hello...", but newer multi-locale voices
// use a single space and parens ("Eddy (English (US)) en_US  # ...") and some
// locales carry digits ("Majed  ar_001  # ..."). Split on '#', then peel the
// locale (last word) off the left; everything before it is the name.
function parseSayVoices(stdout) {
  const voices = [];
  for (const line of String(stdout || '').split('\n')) {
    const hash = line.indexOf('#');
    if (hash < 0) continue;
    const left = line.slice(0, hash).trim();
    const sample = line.slice(hash + 1).trim();
    const m = /^(.*\S)\s+([A-Za-z]{2,3}(?:_[A-Za-z0-9]+)?)$/.exec(left);
    if (!m) continue;
    const name = m[1].trim();
    voices.push({ name, locale: m[2], sample, tier: macosTier(name) });
  }
  return sortVoices(dedupeByName(voices));
}

// Parse the pipe-delimited output of SAPI_LIST_SCRIPT → the same shape.
// "Microsoft David Desktop|en-US|Male" → locale normalized to macOS's en_US
// form so the pickers can render one column for both platforms. SAPI exposes no
// sample sentence, so `sample` is the gender hint when there is one, else ''.
function parseSapiVoices(stdout) {
  const voices = [];
  for (const line of String(stdout || '').split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    if (!name) continue;
    const locale = parts[1].trim().replace('-', '_') || 'en_US';
    const gender = (parts[2] || '').trim();
    voices.push({
      name,
      locale,
      sample: gender && gender !== 'NotSet' ? gender : '',
      tier: 1,
    });
  }
  return sortVoices(dedupeByName(voices));
}

// Escape a JS string for embedding in a PowerShell SINGLE-quoted literal, where
// '' is the only escape and nothing else (no $ expansion, no backticks) is
// interpreted. Used for temp paths and the voice name; the utterance itself is
// never embedded — it is read from a file (see sapiRenderScript).
function psQuote(str) {
  return `'${String(str == null ? '' : str).replace(/'/g, "''")}'`;
}

// PowerShell that prints the installed SAPI voices, one per line.
// Disabled voices are skipped — SelectVoice() would throw on them anyway.
const SAPI_LIST_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
  `Add-Type -AssemblyName System.Speech`,
  `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
  `foreach ($v in $synth.GetInstalledVoices()) {`,
  `  if (-not $v.Enabled) { continue }`,
  `  $i = $v.VoiceInfo`,
  `  Write-Output ("{0}|{1}|{2}" -f $i.Name, $i.Culture.Name, $i.Gender)`,
  `}`,
  `$synth.Dispose()`,
].join('\n');

// PowerShell that renders `textPath` (a UTF-8 file) to `wavPath` in `voice`.
//
// The utterance comes from a FILE rather than the script body: it is arbitrary
// model output, and a file sidesteps quoting, length limits, and any chance of
// script injection. The format is pinned to 16-bit 22.05kHz mono to match what
// the macOS path hands back (afconvert -d LEI16@22050), so the renderer's Web
// Audio decode sees one shape on both platforms.
//
// An unknown voice name makes SelectVoice throw; swallow it and let SAPI use the
// system default rather than going silent — the same instinct as the ElevenLabs
// fallback in main.js.
function sapiRenderScript({ textPath, wavPath, voice }) {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName System.Speech`,
    `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
    `$voice = ${psQuote(voice)}`,
    `if ($voice) { try { $synth.SelectVoice($voice) } catch { } }`,
    `$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, ` +
      `[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, ` +
      `[System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `$synth.SetOutputToWaveFile(${psQuote(wavPath)}, $fmt)`,
    `$synth.Speak([IO.File]::ReadAllText(${psQuote(textPath)}, [Text.Encoding]::UTF8))`,
    `$synth.Dispose()`,
  ].join('\n');
}

// PowerShell's -EncodedCommand takes base64 of UTF-16LE. Going through it rather
// than a temp .ps1 keeps execution policy out of the picture entirely (policy
// gates -File, not -Command) and leaves no script file to clean up.
function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

// Argv for running a script under Windows PowerShell. powershell.exe (not pwsh)
// because it ships with every Windows install and always has System.Speech.
function powerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)];
}

// What to call the built-in voices in UI/agent-facing copy.
function systemVoiceLabel(platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'system';
}

module.exports = {
  SYSTEM_VOICE_PLATFORMS,
  SAPI_LIST_SCRIPT,
  macosTier,
  sortVoices,
  parseSayVoices,
  parseSapiVoices,
  psQuote,
  sapiRenderScript,
  encodePowerShellCommand,
  powerShellArgs,
  systemVoiceLabel,
};
