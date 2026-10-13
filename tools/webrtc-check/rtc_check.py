"""REAL WebRTC transcription check (no browser): our server issues the ephemeral
token exactly as for the phone, then this client streams a TTS WAV over WebRTC to
OpenAI, commits the turn manually, and records the data-channel events.
Prints event types/text/timings only, never the token."""
import asyncio, json, sys, time, re
import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

BASE = sys.argv[1]
ENV = sys.argv[2]
WAV = sys.argv[3]

token = None
for line in open(ENV, encoding="utf-8"):
    m = re.match(r"^APP_ACCESS_TOKEN=['\"]?([^'\"\n]+)", line.strip())
    if m:
        token = m.group(1)

async def main():
    hdr = {"Content-Type": "application/json", "Origin": BASE}
    async with aiohttp.ClientSession() as http:
        r = await http.post(f"{BASE}/api/login", json={"token": token}, headers=hdr)
        assert r.status == 200, r.status
        r = await http.post(f"{BASE}/api/realtime/session", json={}, headers=hdr)
        sess = await r.json()
        assert r.status == 200, sess
        print(f"ephemeral token: prefix {sess['clientSecret'][:3]} (hidden), model {sess['model']}, rtcUrl {sess['rtcUrl']}")

        pc = RTCPeerConnection()
        player = MediaPlayer(WAV)
        pc.addTrack(player.audio)
        dc = pc.createDataChannel("oai-events")
        events = []
        t0 = None
        done = asyncio.Event()
        opened = asyncio.Event()

        @dc.on("open")
        def _open():
            opened.set()

        @dc.on("message")
        def _msg(raw):
            ev = json.loads(raw)
            now = time.perf_counter()
            events.append((now, ev))
            t = ev.get("type")
            extra = ""
            if t.endswith(".delta"):
                extra = repr(ev.get("delta"))
            elif t.endswith(".completed"):
                extra = repr(ev.get("transcript"))
                done.set()
            elif t == "error":
                extra = json.dumps(ev.get("error"))
            elif t == "input_audio_buffer.committed":
                extra = f"item_id={ev.get('item_id')} previous_item_id={ev.get('previous_item_id')}"
            ids = f"item_id={ev.get('item_id')} content_index={ev.get('content_index')}" if "transcription" in t else ""
            print(f"  +{(now - t0) if t0 else 0:6.2f}s {t} {ids} {extra}")

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        r = await http.post(sess["rtcUrl"], data=pc.localDescription.sdp,
                            headers={"Authorization": f"Bearer {sess['clientSecret']}", "Content-Type": "application/sdp"})
        answer = await r.text()
        print(f"SDP exchange: HTTP {r.status}, answer {len(answer)} bytes")
        assert r.status in (200, 201), answer[:300]
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        await asyncio.wait_for(opened.wait(), 15)
        t0 = time.perf_counter()
        print("data channel open; streaming ~4.5 s of TTS speech")
        await asyncio.sleep(5.5)  # audio duration + trailing silence
        commit_at = time.perf_counter()
        dc.send(json.dumps({"type": "input_audio_buffer.commit"}))
        print(f"  +{commit_at - t0:6.2f}s >>> input_audio_buffer.commit sent")
        try:
            await asyncio.wait_for(done.wait(), 15)
        except asyncio.TimeoutError:
            print("no completed event within 15 s")
        await asyncio.sleep(0.5)
        first_delta = next((t for t, e in events if e.get("type", "").endswith("transcription.delta")), None)
        completed = next((t for t, e in events if e.get("type", "").endswith("transcription.completed")), None)
        print("event types:", sorted({e.get("type") for _, e in events}))
        if first_delta:
            print(f"first partial at +{first_delta - t0:.2f}s after audio start")
        if completed:
            print(f"final transcript {completed - commit_at:.2f}s after commit")
        await pc.close()

asyncio.run(main())
