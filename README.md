# Kana drill

A single-page drill for memorizing the 46 basic hiragana and katakana.

Open `index.html` in a browser. No build step and no install.

## How it works

- Pick Hiragana, Katakana, or Mixed (keys `1`, `2`, `3`).
- A kana appears. Type its romaji and press `Enter`.
- Correct: the card turns green and the next kana loads.
- Wrong: the card turns red and the correct romaji appears below the input. Press `Enter` to continue.
- Stuck: press `Space` (or tap "reveal") to see the answer. This counts as a miss.
- `Esc` returns to the menu.

The header shows the current streak, the best streak for that mode, and accuracy. Best streaks are saved in the browser. Missed kana are listed at the bottom under "review" and come up more often for the rest of the session.

Accepted alternate spellings: `si` (shi), `ti` (chi), `tu` (tsu), `hu` (fu), `o` (wo), `nn` (n).

## Editing the character set

The kana data is the `KANA` array near the top of the `<script>` block in `index.html`. Each entry has `romaji`, `hiragana`, and `katakana`. Alternate spellings live in `ALTERNATES`.

## Hosting

Any static host works. For GitHub Pages: Settings → Pages → deploy from the branch root.
