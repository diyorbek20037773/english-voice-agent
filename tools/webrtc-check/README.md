# Real WebRTC transcription check (optional)

Verifies the exact browser flow without a phone: our server issues an ephemeral token, then a
Python WebRTC client (aiortc) streams a WAV file to OpenAI over `/v1/realtime/calls`, commits the
turn, and prints data-channel events and timings. Costs about $0.002 (a few seconds of audio).
The token is never printed.

```powershell
# 1. Python venv with aiortc (outside the repo is fine)
py -3.12 -m venv $env:TEMP\eva-rtc
& $env:TEMP\eva-rtc\Scripts\python.exe -m pip install aiortc aiohttp

# 2. English speech WAV with Windows text-to-speech
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, 'Sixteen', 'Mono')
$s.SetOutputToWaveFile("$env:TEMP\question.wav", $f)
$s.Speak("What is the difference between a process and a thread in an operating system?")
$s.Dispose()

# 3. Run the app (ALLOWED_ORIGIN must match the URL), then:
& $env:TEMP\eva-rtc\Scripts\python.exe tools\webrtc-check\rtc_check.py http://localhost:3000 .env $env:TEMP\question.wav
```
