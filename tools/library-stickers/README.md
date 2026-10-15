# Library stickers (local only)

Nothing here ships: the Worker bundles only `src/`.

These scripts make the stickers that go on the library games' boxes. The output is a PDF for Dice Goblin's thermal sticker printer:

- Pages are landscape, 150 × 100 mm, with dashed lines to cut along.
- It's black and white only, with no greys.
- `--layout=` picks how the stickers are laid out:
  - `box` (the default): two 75 × 100 mm stickers a page, for the box (below).
  - `box-label`: the same with each game's spine label underneath (see Spine labels).
  - `spine`: one tall sticker per game with everything on it, for the spine (see Spine stickers).

Each box sticker has:

- the game's name
- a QR code holding the copy's barcode, the value Shopify POS and My Lair find the copy by
- the shelf code in big type
- the shelf
- players, play time and ages

There's no heading or footer, so everything can be big (Mo, 10 Oct 2026).

### Spine stickers (`--layout=spine`, 11 Oct 2026)

Mo: "make the QR code be placed and everything written on the spine of the game and I will have it all spine
facing ... split it into maybe 50 and get 3 games at a time". With `--layout=spine` each game gets one tall sticker
for its spine, 100 mm tall:

- From the top: the section in a black band (3–4 PLAYERS, KIDS & FAMILY, RPG BOOKS), the size letter and number big
  (M052), the full code, the QR code, then the name and details. Every sticker is laid out from the top, so with each
  stuck at the same height the numbers line up along the shelf.
- Every game gets a 30 mm wide sticker, five a page: Mo picked these over 50 mm ones, three a page ("It looks better
  I feel and should be easy enough to install on all", 11 Oct). They fit spines down to about 3 cm.
- The QR code is the plain one (23 mm): Gobgob's version read from about half the 'phone photos' at that size, the
  plain one from nearly all. The name and details run down the spine like a book's title, and Gobgob sits at the foot.
- A `spine` field of `wide` in the games list gives that game the 50 mm sticker instead, with Gobgob in its 41 mm QR
  code, on pages of three.
- Pages hold one width, in shelf order, so every page of a width has its cut lines in the same places and a stack
  can be cut at once.
- An outline is printed 2 mm inside the cut lines, so a sticker looks finished however it's cut out.
- All 533 games build and check both ways (every game wide, and every game narrow): no name cut short, every QR code
  read at 203 dpi.

### The renumbering (`renumber-2026-10-11/`, 11–12 Oct 2026)

Mo: "find out the sizes of all first and then assign the codes accordingly". Every board game got a box size and a
new code: section, size letter, then its place in A–Z order within that run (DGL34-022 Catan is now DGL34-M011). RPG
books keep their codes.

- Sizes come from BoardGameGeek's printings (`bgg-printings.json`: each game's English printings, else any language),
  read through its versions API one request at a time. `classify.py` takes the size most recent English printings
  have: small if the longest side is 24 cm or less; large if longer than 32 cm, 3 kg or more, or thicker than 9 cm on
  a box over 27.5 cm; medium otherwise. 446 games had measurements.
- `final_sizes.py` adds 5 corrections (where BGG mixes in another box: Munchkin, Munchkin Harry Potter Deluxe, Everdell:
  The Complete Collection, Ready Set Bet, Smartphone Inc.) and educated guesses for the 51 with no measurements (card
  decks, mass-market and kids' games), each marked as such.
- `assign_codes.py` numbers each section and size from 001 (a leading "The" ignored, as before) and writes `codes.json`:
  old code, new code, size and where it came from, for all 533. `print-games.json` is the sticker list in shelf order.
- 194 small, 227 medium, 76 large, 36 RPG books. The spine stickers: 107 pages, five a page.
- Running the three scripts again from the kept data gives the same codes.
- **Live in Shopify since 12 Oct 2026** (Mo: "Yes switch now"). For all 497 board games the product's
  `custom.library_code`, then the variant's barcode and SKU, were set to the new code (`shopify-switch.json` lists
  each product and variant with its old and new code, for checking or putting back), then read back: all 497 match.
  The "Library code" metafield definition's rule was changed to fit:
  `^(DGL(12|34|56|7\+|F)-[SML][0-9]{3}|DGLRPG-[0-9]{3})$` (the old rule only allowed three digits after the dash, so
  the first try was refused for the codes while the barcodes and SKUs went through; the rule was widened, the batch
  run again and the rest followed).
- The Lair learns each game's new code the first time its new sticker is scanned (it looks the barcode up in
  Shopify). Until then its saved copy of the old code still shows on the staff page and My Lair, and current holds and
  loans keep the code they were made with.

### New games and extra copies (`additions-2026-10-16/`, 16 Oct 2026)

Mo photographed the new games' box fronts in piles and asked for the stickers "grouped together as per the images I
took of the boardgames". `print-games.json` is that print, 233 stickers in the order Mo will stick them on:

- Each sticker has a `group`: `Photo 1` to `Photo 13` (his photos in the order he sent them), then `Extra copies`, then
  `RPG shelf`. Within a photo they're in the order the games were read off it.
- Built with `--order=given`, so nothing is re-sorted, and every group starts a new page: each pile's stickers come
  off the printer together (52 pages, a few with gaps at a group's end).
- New games took the next free number in their section and size run (DGL7+-L008 after Kaupapa's L007). Codes are
  never reused: the 57 sold games archived that day keep theirs, retired.
- A second or third copy of a game has the same code and QR as the first, so the list repeats it (Forbidden Island
  twice for its two new copies). Shopify counts the copies in the variant's stock.
- The photographed games already in the library are in the list again, because their stickers had gone missing.
- RPG books, magazines and comics (the RPG shelf) have numbers only, and new ones have no players, time or ages yet.

### Spine labels (`--layout=box-label`, 11 Oct 2026)

Mo asked for each game's spine label to print with its sticker, two games a page. With `--layout=box-label`:

- The bottom 30 mm of each page holds the two spine labels, each in a 30 mm square either side of the middle cut
  line, so each sits under its own sticker. Cut across above them, down the middle, then round each square.
- The spine label is 25 × 25 mm with its outline printed, so it fits a 3 cm spine and looks finished however it's cut
  out. It has the section in a black band (3–4 PLAYERS, KIDS & FAMILY, RPG BOOKS), then the size letter and number big
  (M052), then the full code small. Today's codes have no size letter, so they show just the number.
- The sticker above is 70 mm tall instead of 100. The name gets two lines' room (15 pt, smaller when it's long), the
  shelf line goes (the spine label says it), and the QR code is 38 mm instead of 52. It still read from every 'phone
  photo' in the tests; scratches it can take are about three quarters the size.

### The Dice Goblin logo (11 Oct 2026, two options for Mo to pick from)

Mo asked for the logo on the stickers, in black and white. `--logo=` picks one of two ways (leave it off for the
plain stickers):

- `--logo=qr`: Gobgob in the middle of the QR code. The code is QR version 5 at error correction H, with its middle
  11 × 11 modules left white for him. In tests it read with an 11 mm scuff anywhere on it, and from blurred, turned and
  tilted "phone photos" nearly as often as the plain code (a bigger hole, or version 6, read noticeably less often).
- `--logo=qr-stacked`: the stacked DICE / Gobgob / GOBLIN logo in the middle of the QR code instead (Mo sent it to
  try, 11 Oct), in a taller white space (11 × 13 modules) so the words are about 14 mm tall in all. It read as well in
  the tests (a 9 mm scuff anywhere; 13 × 15 didn't). `dg-logo-stacked.png` is Mo's full-size file; without it the
  theme's smaller `dg-logo-stacked-640.png` is used.
- `--logo=band`: the DICE GOBLIN wordmark across the top, 58 mm wide, above the name. The QR code stays the plain
  one, but smaller (about 38 mm instead of 52) to make room.

The logos are the theme's own PNGs (`gobgob-480.png`, `dg-wordmark-960.png`). Every colour darker than
`LOGO_THRESHOLD` prints black (the outlines, Gobgob's hood); the bright green and the bag go white. They're traced into
solid shapes (potrace), so they print crisp, and each is stored once in the PDF.

`build_logo_samples.py` makes the samples Mo saw (the same two games with each option: `qr,band` by default, or
`qr-stacked`), and
`verify_logo_samples.py` checks it: pure black, the 4 mm margins, every QR code read from the printer's render and
from 'phone photos'.

## Files

- `library_stickers.py` makes the PDF from a games list.
- `verify_stickers.py` checks a PDF the way the printer will see it:
  - every page is 150 × 100 mm, in pure black and white
  - every box sticker's ink sits inside its 4 mm margin
  - every QR code is read back from a 203 dpi one-bit render (a thermal printer's resolution) and matched to its game
  - with `--layout=box-label`: each spine label has 2 mm clear inside its square, and nothing else is printed in the
    strip
  - with `--layout=spine`: each spine sticker has 1.6 mm clear inside its cut lines, and a page's empty places are
    empty
- `games-2026-10-10.json` lists all 533 library games as they were on 10 October 2026.
- `test-games.json` holds the four games of the test print.
- `extract_pages.py` and `build_games.py` turned the Shopify query results into the games list (see below).
- `build_logo_samples.py` and `verify_logo_samples.py`: the two logo options' sample and its check (see above).

## Make the stickers

You need Python 3 with `reportlab segno fonttools brotli zxing-cpp pypdf numpy pillow` (and `potracer` for the logo,
`opencv-python` for the sample check), and poppler's `pdftoppm`. The fonts are the theme's own (Archivo Black and Poppins), read from the website repo's `assets` folder.

```sh
python3 library_stickers.py games-2026-10-10.json stickers.pdf /path/to/Dice-Goblin-website/assets layout.json [--logo=qr|qr-stacked|band] [--layout=box|box-label|spine] [--order=shelf|given]
python3 verify_stickers.py stickers.pdf games-2026-10-10.json [render_dir] [--layout=box|box-label|spine] [--order=shelf|given]
```

- Stickers come out in shelf order, so each shelf's games are together: by section, then small, medium and large boxes
  (S, M, L: top shelf down), then number.
- `--order=given` keeps the list's own order instead. With spine stickers, a game whose `group` differs from the one
  before starts a new page. Give the check the same flag.
- The 16 October print: `python3 library_stickers.py additions-2026-10-16/print-games.json stickers.pdf
  /path/to/Dice-Goblin-website/assets --layout=spine --logo=qr --order=given`.
- `layout.json` is optional. It records each sticker's choices: name lines and size, details lines, QR size and page.
- To print new games only, give `library_stickers.py` a list with just those games.

## Getting the games again

The games are the products in the `board-game-rental` collection that have a `custom.library_code`. The membership products sit in that collection too and have no code.

This query pulls them 100 at a time:

```graphql
query LibraryStickers($after: String) {
  collectionByIdentifier(identifier: {handle: "board-game-rental"}) {
    products(first: 100, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        t: title
        s: status
        c: metafield(namespace: "custom", key: "library_code") { v: value }
        p: metafield(namespace: "custom", key: "players") { v: value }
        m: metafield(namespace: "custom", key: "play_time") { v: value }
        a: metafield(namespace: "shopify", key: "recommended-age-group") { v: value }
        variants(first: 2) { nodes { b: barcode k: sku } }
      }
    }
  }
}
```

`shopify.recommended-age-group` holds metaobject IDs. Look them up with `nodes(ids:)`; each one's `label` field is the text, like "Teens" or "10 years or older".

The 10 October list was made inside a Claude session:

1. `extract_pages.py` read the query results straight out of the session's log, so nothing was retyped by hand.
2. `build_games.py` turned those results into the games list.

Each game in the list has:

- `title`, without " (Library)"
- `code`
- `qr`: the barcode, else the SKU, else the code
- `players` and `time`
- `ages`: the age group's label

## How a sticker is laid out

**Name**
- Names start at 17pt, on up to three lines.
- A long name shrinks to fit the same space, taking four lines once it's 12pt or smaller. That keeps every QR code the same size: 51.8 mm square, its quiet zone included.
- Lines break at the name's own colons, dashes and brackets where they can.
- `KEEP_TOGETHER` lists phrases that shouldn't be split across lines, like "Star Wars" and "New Zealand".
- If dropping a point of size avoids an awkward break, the name drops it.

**Characters the font can't draw**
- A name with characters outside the font uses its bracketed English name: "스플렌더: Pokémon (Splendor: Pokémon)" prints as "Splendor: Pokémon".
- Subscript digits, like the 2 in CO₂, are drawn as small, lowered ordinary digits.

**Details**
- Players, play time and ages go on one line if it fits at 10pt or more. Otherwise they take two lines, which 8 of the 533 games need.
- Ages read like the website's: "10 years or older" becomes "Ages 10+", and a word like "Teens" stays as it is.

**QR codes**
- Error correction is level H, so a scuffed sticker still scans.
- Each code keeps the standard four-module quiet zone.
