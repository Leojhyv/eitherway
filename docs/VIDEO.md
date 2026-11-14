# The demo video

`video/out/eitherway-demo.mp4`: 1 minute 57 seconds, 14 MB, 1920x1080, H.264 + AAC.
X allows 2:20 and 512 MB on a free account.

## What it says

Problem first, then the one change, then who pays, then one example of each
outcome, then the number, then how it runs on NEAR.

| Scene | Voice |
|---|---|
| Problem | Most crowdfunding campaigns fail. Not because nobody wanted them. Because everyone waited for everyone else. Going first is a risk. Your money sits locked, and if the goal is missed, you waited for nothing. So people hold back. And good ideas die. |
| The change | EitherWay changes one thing. If a campaign misses its goal, every backer gets their money back, plus a bonus for the wait. So going first can't hurt you. Either it gets funded, or you get paid. |
| Who pays | Who pays that bonus? An underwriter. Underwriters are AI agents with their own money. For each campaign, they bid in a sealed auction for the right to guarantee it. The lowest fee wins, and locks up a bond. If the campaign succeeds, it keeps its fee. If it fails, the bond pays the backers. |
| Funded | Here is one campaign, run both ways with the same crowd. As ordinary crowdfunding, nobody went first. It raised nothing. With a guarantee, the backers had no reason to wait. Funded. |
| Fell short | And when a campaign really does fall short, nobody is left out of pocket. Here, seven backers got every pledge back, plus a bonus, paid by the underwriter who called it wrong. |
| The number | We simulated the same crowd both ways, two hundred times. Ordinary crowdfunding funded twenty-four percent of campaigns. EitherWay funded fifty-three. Same people. Same wishes. |
| On NEAR | On NEAR testnet, every agent has its own account, and they meet on near dot social. The announcement is a post. Interest is a like. The guarantee is a reply. And the rules live in a contract that nobody owns. |
| Close | EitherWay. Back what you want to exist. Either it gets funded, or you get paid. |

The "On NEAR" line follows `data/latest.json`: it names testnet because the
recorded run is the testnet one, and the end of the video films that run's
page. (With only a local run it says "Each agent is built to run from its own
NEAR account".) The video does not say "built at NEAR hackathon"; the X post
does.

## How it is made

Everything is scripted, so it can be made again after any change.

```
node video/script.mjs        # builds the narration from the project's own data
python video/voice.py        # speaks it, one cached file per line, and lays the track
node video/film.mjs          # films the real page frame by frame, following the voice
python video/mix.py          # joins picture and voice at -16 LUFS
python video/check.py        # transcribes the result and compares it with the script
python video/sheet.py video/out/eitherway-demo.mp4   # contact sheets to check by eye
```

`film.mjs` needs `FFMPEG` set to an ffmpeg executable and `playwright-core`
1.65.0 (`cd video && npm install`). The Python scripts need `edge-tts`,
`numpy`, `soundfile`, `imageio-ffmpeg`, `Pillow` and, for the check,
`faster-whisper`.

- **The words cannot drift from the picture.** `script.mjs` takes its numbers
  (24%, 53%, seven backers, which campaigns to show) from the simulation and
  the 200-crowd summary, and stops if the data no longer supports a sentence.
  `film.mjs` stops if the page is not showing the crowd the script was written
  for, or if the narration and the page disagree about testnet.
- **What is filmed** is the page itself, driven through a handle it exposes,
  with a camera that moves in on what the voice is describing.
- **What is drawn** rather than filmed: the opening picture of a campaign
  nobody dares to back first (the page has no view of that; its numbers come
  from the simulation), the small "same campaign as ordinary crowdfunding"
  strip, the captions, and the end card.
- **The voice is an AI voice**: Microsoft Edge's online text-to-speech, voice
  `en-US-AndrewMultilingualNeural`, through the `edge-tts` package. The end
  card says so.
