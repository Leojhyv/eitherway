"""Speaks video/work/script.json and lays the lines on one track.

    python video/voice.py            (needs edge-tts, numpy, soundfile, imageio-ffmpeg)

Writes video/work/voice.wav and video/work/timeline.json (when each line
starts and ends, so the picture can follow the voice).

Each line is spoken once and cached by its text, voice and mood: change one
sentence and only that sentence is spoken again.

The voice is Microsoft Edge's online text-to-speech (through the edge-tts
package). It is an AI voice, and the video's end card says so.
"""

import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import imageio_ffmpeg
import edge_tts

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
CACHE = WORK / "voice"
RATE = 48000
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# Small nudges only: big changes are what make a synthetic voice sound synthetic.
MOODS = {
    "flat":    {"rate": "-4%",  "pitch": "+0Hz"},
    "warm":    {"rate": "-6%",  "pitch": "-1Hz"},
    "low":     {"rate": "-10%", "pitch": "-3Hz"},
    "weight":  {"rate": "-12%", "pitch": "-2Hz"},
    "bright":  {"rate": "-2%",  "pitch": "+2Hz"},
    "curious": {"rate": "-4%",  "pitch": "+3Hz"},
}


async def speak(text: str, voice: str, mood: str, out: Path) -> None:
    settings = MOODS[mood]
    for attempt in range(6):
        try:
            talk = edge_tts.Communicate(text, voice, rate=settings["rate"], pitch=settings["pitch"])
            data = bytearray()
            async for chunk in talk.stream():
                if chunk["type"] == "audio":
                    data.extend(chunk["data"])
            if len(data) < 2000:
                raise RuntimeError("the service returned almost no audio")
            out.write_bytes(bytes(data))
            return
        except Exception as error:  # the free service drops connections now and then
            print(f"  retry {attempt + 1} for {out.name}: {error}")
            await asyncio.sleep(2 + attempt * 2)
    raise SystemExit(f"could not speak: {text}")


def decode(mp3: Path) -> np.ndarray:
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(mp3), "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def trim(audio: np.ndarray, floor: float = 0.006, keep: float = 0.04) -> np.ndarray:
    """Cuts the silence the service adds around a line, leaving a short breath."""
    loud = np.flatnonzero(np.abs(audio) > floor)
    if loud.size == 0:
        return audio
    pad = int(keep * RATE)
    return audio[max(0, loud[0] - pad): min(len(audio), loud[-1] + pad)]


def level(audio: np.ndarray, target: float = 0.085) -> np.ndarray:
    """Brings every line to about the same loudness without squashing it."""
    rms = float(np.sqrt(np.mean(audio**2))) or 1.0
    gain = min(target / rms, 4.0)
    out = audio * gain
    peak = float(np.max(np.abs(out))) or 1.0
    return out * min(1.0, 0.92 / peak)


def fade(audio: np.ndarray, ms: float = 8) -> np.ndarray:
    n = min(int(ms / 1000 * RATE), len(audio) // 2)
    if n > 0:
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        audio[:n] *= ramp
        audio[-n:] *= ramp[::-1]
    return audio


async def main() -> None:
    script = json.loads((WORK / "script.json").read_text(encoding="utf-8"))
    CACHE.mkdir(parents=True, exist_ok=True)
    voice = script["voice"]

    track = [np.zeros(int(0.6 * RATE), dtype=np.float32)]  # a beat before the first word
    cursor = track[0].size
    timeline = []
    for line in script["lines"]:
        key = hashlib.sha256(f"{voice}|{line['mood']}|{line['say']}".encode()).hexdigest()[:16]
        mp3 = CACHE / f"{line['id']}-{key}.mp3"
        if not mp3.exists():
            print(f"speaking {line['id']}: {line['say']}")
            await speak(line["say"], voice, line["mood"], mp3)
        audio = fade(level(trim(decode(mp3))))
        start = cursor
        track.append(audio)
        cursor += audio.size
        gap = np.zeros(int(line["pause"] / 1000 * RATE), dtype=np.float32)
        track.append(gap)
        cursor += gap.size
        timeline.append({**line, "start": round(start / RATE, 3), "end": round((start + audio.size) / RATE, 3), "file": mp3.name})

    track.append(np.zeros(int(2.5 * RATE), dtype=np.float32))  # hold on the end card
    full = np.concatenate(track)
    sf.write(WORK / "voice.wav", full, RATE, subtype="PCM_16")
    duration = full.size / RATE
    (WORK / "timeline.json").write_text(json.dumps({**script, "lines": timeline, "duration": round(duration, 3)}, indent=1), encoding="utf-8")
    print(f"voice track: {duration:.1f} s ({int(duration // 60)}:{int(duration % 60):02d}); X allows 2:20 on a free account")
    if duration > 140:
        sys.exit("too long for X: cut the script")


if __name__ == "__main__":
    asyncio.run(main())
