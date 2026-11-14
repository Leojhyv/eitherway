"""Tiles frames from a video into contact sheets, so the film can be checked by eye.

    python video/sheet.py video/work/proof-2fps.mp4 --every 6 --cols 4
"""
import argparse
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("video")
parser.add_argument("--every", type=float, default=6.0, help="seconds between frames")
parser.add_argument("--cols", type=int, default=4)
parser.add_argument("--width", type=int, default=640)
parser.add_argument("--start", type=float, default=0.0)
parser.add_argument("--end", type=float, default=None)
parser.add_argument("--per-sheet", type=int, default=12)
args = parser.parse_args()

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
video = Path(args.video)
probe = subprocess.run([ffmpeg, "-i", str(video)], capture_output=True, text=True).stderr
h, m, s = probe.split("Duration: ")[1].split(",")[0].split(":")
duration = int(h) * 3600 + int(m) * 60 + float(s)
end = min(duration, args.end) if args.end else duration

times = []
t = args.start
while t < end - 0.01:
    times.append(t)
    t += args.every
height = args.width * 9 // 16
frames = []
for t in times:
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={args.width}:{height}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
    ).stdout
    image = Image.frombytes("RGB", (args.width, height), raw)
    ImageDraw.Draw(image).text((8, 6), f"{int(t // 60)}:{t % 60:04.1f}", fill=(255, 220, 0))
    frames.append(image)

out_dir = video.parent / "sheets"
out_dir.mkdir(exist_ok=True)
for n in range(0, len(frames), args.per_sheet):
    chunk = frames[n:n + args.per_sheet]
    rows = (len(chunk) + args.cols - 1) // args.cols
    sheet = Image.new("RGB", (args.cols * args.width, rows * height), (20, 20, 20))
    for i, image in enumerate(chunk):
        sheet.paste(image, ((i % args.cols) * args.width, (i // args.cols) * height))
    name = out_dir / f"{video.stem}-{n // args.per_sheet + 1:02d}.jpg"
    sheet.save(name, quality=85)
    print(name)
