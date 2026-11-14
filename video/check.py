"""Listens to the finished video and compares it with the script.

    python video/check.py                    (needs faster-whisper)

A speech-recognition model transcribes each line from the final file. A line
is flagged when what it heard differs from what the script says, which is how
a slurred or mispronounced word gets caught without anyone listening.
"""

import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from faster_whisper import WhisperModel

HERE = Path(__file__).resolve().parent
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
video = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out" / "eitherway-demo.mp4"
timeline = json.loads((HERE / "work" / "timeline.json").read_text(encoding="utf-8"))

raw = subprocess.run(
    [FFMPEG, "-v", "error", "-i", str(video), "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
    check=True, capture_output=True,
).stdout
audio = np.frombuffer(raw, dtype=np.float32)
# base.en is enough to catch a wrong word, and fits in memory on a busy machine.
model = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=2)

# Spellings that sound the same: not errors.
SAME = {"a.i.": "ai", "nier": "near", "neer": "near", "either way": "eitherway", "can not": "cannot", "%": " percent",
        "change is one thing": "changes one thing", "nearsocial": "near dot social", "near.social": "near dot social",
        "crowd funding": "crowdfunding", "is alike": "is a like"}

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def spell(match: re.Match) -> str:
    """Digits as the words a voice would say, so "24" and "twenty-four" compare equal."""
    n = int(match.group(0))
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000 and n % 100 == 0:
        return ONES[n // 100] + " hundred"
    return match.group(0)


def words(text: str) -> list[str]:
    text = text.lower().replace(",", "")
    for a, b in SAME.items():
        text = text.replace(a, b)
    text = re.sub(r"\d+", spell, text)
    return re.sub(r"[^a-z0-9 ]", " ", text.replace("-", " ")).split()


bad = 0
for line in timeline["lines"]:
    a = max(0, int((line["start"] - 0.15) * 16000))
    b = int((line["end"] + 0.25) * 16000)
    segments, _ = model.transcribe(audio[a:b], language="en", beam_size=5, condition_on_previous_text=False)
    heard = " ".join(s.text.strip() for s in segments)
    ratio = difflib.SequenceMatcher(None, words(line["say"]), words(heard)).ratio()
    ok = ratio >= 0.9
    bad += 0 if ok else 1
    print(f"{'ok  ' if ok else 'CHECK'} {line['id']} {ratio:.2f}  {heard}")
    if not ok:
        print(f"           script: {line['say']}")

print(f"\n{len(timeline['lines']) - bad} of {len(timeline['lines'])} lines heard as written")
sys.exit(1 if bad else 0)
