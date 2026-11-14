// The narration, built from the project's own data so the words cannot drift
// away from what is on screen. Writes video/work/script.json.
//
//   node video/script.mjs
//
// Each line has what the voice says (`say`), what the caption shows
// (`caption`), a mood for the voice, and a pause after it. If the data stops
// supporting a sentence, this script stops instead of narrating something
// untrue.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from '../swarm/sim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const must = (ok, what) => { if (!ok) throw new Error(`the data no longer supports the script: ${what}`); };

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words = (n) => (n < 20 ? ONES[n] : n === 100 ? 'one hundred' : n === 200 ? 'two hundred' : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export const SEED = 7;
const run = compare(SEED);
const sweep = JSON.parse(readFileSync(join(root, 'data', 'sweep.json'), 'utf8'));
const latest = JSON.parse(readFileSync(join(root, 'data', 'latest.json'), 'utf8'));

// The two campaigns the film shows.
const rounds = run.eitherway.rounds;
const winIndex = rounds.findIndex((r, i) => r.status === 'Funded' && !r.rescued && r.bids.length >= 4 && run.plain.rounds[i].raised === 0 && r.demandRatio >= 1.3);
const missIndex = rounds.findIndex((r) => r.status === 'Failed' && r.underwriter && r.bonusPaid > 1 && r.backers >= 5);
must(winIndex >= 0, 'no campaign that fails ordinarily at 0% and is funded with a guarantee');
must(missIndex >= 0, 'no guaranteed campaign that fell short with several backers');
const win = rounds[winIndex];
const miss = rounds[missIndex];
must(win.clearingFeeBps < 100, 'the winning fee in the example is under one percent');

const fundedPlain = Math.round(sweep.fundedPlain * 100);
const fundedNew = Math.round(sweep.fundedEitherWay * 100);
must(sweep.seeds === 200, 'the summary covers 200 crowds');
must(fundedNew > fundedPlain + 15, 'the funded rate roughly doubles');
const onChain = !['local', 'local rehearsal'].includes(latest.network);

const lines = [
  // scene, id, mood, pause after (ms), what is said, caption
  ['problem', 'a1', 'flat', 350, 'Most crowdfunding campaigns fail.', 'Most crowdfunding campaigns fail.'],
  ['problem', 'a2', 'flat', 250, 'Not because nobody wanted them.', 'Not because nobody wanted them.'],
  ['problem', 'a3', 'weight', 650, 'Because everyone waited for everyone else.', 'Because everyone waited for everyone else.'],
  ['problem', 'b1', 'warm', 350, 'Going first is a risk. Your money sits locked, and if the goal is missed, you waited for nothing.', 'Going first is a risk. If the goal is missed, you waited for nothing.'],
  ['problem', 'b2', 'low', 800, 'So people hold back. And good ideas die.', 'So people hold back. And good ideas die.'],

  ['solution', 'c1', 'bright', 300, 'EitherWay changes one thing.', 'EitherWay changes one thing.'],
  ['solution', 'c2', 'warm', 400, 'If a campaign misses its goal, every backer gets their money back, plus a bonus for the wait.', 'Miss the goal, and every backer gets their money back, plus a bonus for the wait.'],
  ['solution', 'c3', 'bright', 750, "So going first can't hurt you. Either it gets funded, or you get paid.", "Going first can't hurt you. Either it gets funded, or you get paid."],

  ['auction', 'd1', 'curious', 300, 'Who pays that bonus? An underwriter.', 'Who pays that bonus? An underwriter.'],
  ['auction', 'd2', 'warm', 350, 'Underwriters are A.I. agents with their own money. For each campaign, they bid in a sealed auction for the right to guarantee it.', 'AI agents with their own money bid, sealed, for the right to guarantee each campaign.'],
  ['auction', 'd3', 'warm', 650, 'The lowest fee wins, and locks up a bond. If the campaign succeeds, it keeps its fee. If it fails, the bond pays the backers.', 'Lowest fee wins and locks a bond. Success: it keeps its fee. Failure: the bond pays the backers.'],

  ['funded', 'e1', 'flat', 300, 'Here is one campaign, run both ways with the same crowd.', 'One campaign, run both ways with the same crowd.'],
  ['funded', 'e2', 'low', 350, 'As ordinary crowdfunding, nobody went first. It raised nothing.', 'Ordinary crowdfunding: nobody went first. It raised nothing.'],
  ['funded', 'e3', 'bright', 700, 'With a guarantee, the backers had no reason to wait. Funded.', 'With a guarantee, backers had no reason to wait. Funded.'],

  ['missed', 'f1', 'warm', 300, 'And when a campaign really does fall short, nobody is left out of pocket.', 'And when a campaign really does fall short, nobody is left out of pocket.'],
  ['missed', 'f2', 'warm', 700, `Here, ${words(miss.backers)} backers got every pledge back, plus a bonus, paid by the underwriter who called it wrong.`, `${cap(words(miss.backers))} backers got every pledge back, plus a bonus, paid by the underwriter who called it wrong.`],

  ['numbers', 'g1', 'flat', 300, `We simulated the same crowd both ways, ${words(sweep.seeds)} times.`, `The same crowd, simulated both ways, ${sweep.seeds} times.`],
  ['numbers', 'g2', 'bright', 350, `Ordinary crowdfunding funded ${words(fundedPlain)} percent of campaigns. EitherWay funded ${words(fundedNew)}.`, `Ordinary crowdfunding funded ${fundedPlain}% of campaigns. EitherWay funded ${fundedNew}%.`],
  ['numbers', 'g3', 'low', 700, 'Same people. Same wishes.', 'Same people. Same wishes.'],

  onChain
    ? ['swarm', 'h1', 'warm', 300, 'On NEAR testnet, every agent has its own account, and they meet on near dot social.', 'On NEAR testnet, every agent has its own account, and they meet on near.social.']
    : ['swarm', 'h1', 'warm', 300, 'Each agent is built to run from its own NEAR account, and they meet on near dot social.', 'Each agent is built to run from its own NEAR account, and they meet on near.social.'],
  ['swarm', 'h2', 'flat', 350, 'The announcement is a post. Interest is a like. The guarantee is a reply.', 'The announcement is a post. Interest is a like. The guarantee is a reply.'],
  ['swarm', 'h3', 'flat', 600, 'And the rules live in a contract that nobody owns.', 'And the rules live in a contract that nobody owns.'],

  ['close', 'j1', 'bright', 300, 'EitherWay. Back what you want to exist.', 'EitherWay. Back what you want to exist.'],
  // Spoken with a break after "Either": run together, the voice swallows the word "it".
  ['close', 'j2', 'warm', 1200, 'Either: it gets funded. Or you get paid.', 'Either it gets funded, or you get paid.'],
].map(([scene, id, mood, pause, say, caption]) => ({ scene, id, mood, pause, say, caption }));

const script = {
  seed: SEED,
  voice: 'en-US-AndrewMultilingualNeural',
  onChain,
  facts: {
    winIndex, missIndex,
    win: { title: win.title, goal: win.goal, interested: win.interested, potential: win.potential, bids: win.bids.length, passed: win.passed.length, backers: win.backers },
    miss: { title: miss.title, backers: miss.backers, bonusPaid: miss.bonusPaid, underwriter: miss.underwriter, raisedShare: miss.raised / miss.goal },
    fundedPlain, fundedNew, crowds: sweep.seeds,
  },
  lines,
};

mkdirSync(join(here, 'work'), { recursive: true });
writeFileSync(join(here, 'work', 'script.json'), JSON.stringify(script, null, 1));
const count = lines.reduce((n, l) => n + l.say.split(/\s+/).length, 0);
console.log(`${lines.length} lines, ${count} words; campaigns shown: ${winIndex + 1} (funded) and ${missIndex + 1} (fell short); swarm run: ${onChain ? 'testnet' : 'local'}`);
