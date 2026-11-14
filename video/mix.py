"""Joins the picture and the voice into the final video.

    python video/mix.py

Loudness is set in two passes (measure, then apply the same gain throughout),
so quiet lines stay quiet instead of being pumped up. Target: -16 LUFS, the
usual level for speech online.

Writes video/out/eitherway-demo.mp4 (H.264 in standard-range yuv420p, stereo
AAC: the combination X and phone players handle without surprises).
"""

import json
import re
import subprocess
from pathlib import Path

import imageio_ffmpeg

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
OUT = HERE / "out"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
TARGET = "I=-16:TP=-1.5:LRA=11"

OUT.mkdir(exist_ok=True)
voice = WORK / "voice.wav"
picture = WORK / "picture.mp4"

measure = subprocess.run(
    [FFMPEG, "-hide_banner", "-i", str(voice), "-af", f"loudnorm={TARGET}:print_format=json", "-f", "null", "-"],
    capture_output=True, text=True,
).stderr
found = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", measure, re.S).group(0))
print(f"voice measured at {found['input_i']} LUFS, true peak {found['input_tp']} dB")

loudnorm = (
    f"loudnorm={TARGET}:measured_I={found['input_i']}:measured_TP={found['input_tp']}:"
    f"measured_LRA={found['input_lra']}:measured_thresh={found['input_thresh']}:offset={found['target_offset']}:linear=true"
)
final = OUT / "eitherway-demo.mp4"
subprocess.run(
    [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(picture), "-i", str(voice),
     "-map", "0:v", "-map", "1:a",
     # The frames were JPEGs (full-range colour). Players expect standard range.
     "-vf", "scale=out_range=tv,format=yuv420p", "-color_range", "tv", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
     "-af", loudnorm, "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
     "-shortest", "-movflags", "+faststart", str(final)],
    check=True,
)
info = subprocess.run([FFMPEG, "-hide_banner", "-i", str(final)], capture_output=True, text=True).stderr
duration = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
seconds = int(duration.group(1)) * 3600 + int(duration.group(2)) * 60 + float(duration.group(3))
size = final.stat().st_size / 1e6
print(f"{final}: {int(seconds // 60)}:{seconds % 60:04.1f}, {size:.1f} MB")
print("X free accounts: up to 2:20 and 512 MB." + ("" if seconds <= 140 and size <= 512 else "  TOO LONG OR TOO LARGE"))
