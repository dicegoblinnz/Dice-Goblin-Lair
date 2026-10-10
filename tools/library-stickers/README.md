# Library stickers (local only)

Nothing here ships: the Worker bundles only `src/`.

These scripts make the stickers that go on the library games' boxes. The output is a PDF for Dice Goblin's thermal sticker printer:

- Pages are landscape, 150 × 100 mm.
- Each page holds two 75 × 100 mm stickers, with a dashed cut line down the middle.
- It's black and white only, with no greys.

Each sticker has:

- the game's name
- a QR code holding the copy's barcode, the value Shopify POS and My Lair find the copy by
- the shelf code in big type
- the shelf
- players, play time and ages

There's no heading or footer, so everything can be big (Mo, 10 Oct 2026).

## Files

- `library_stickers.py` makes the PDF from a games list.
- `verify_stickers.py` checks a PDF the way the printer will see it:
  - every page is 150 × 100 mm, in pure black and white
  - every sticker's ink sits inside its 4 mm margin
  - every QR code is read back from a 203 dpi one-bit render (a thermal printer's resolution) and matched to its game
- `games-2026-10-10.json` lists all 533 library games as they were on 10 October 2026.
- `test-games.json` holds the four games of the test print.
- `extract_pages.py` and `build_games.py` turned the Shopify query results into the games list (see below).

## Make the stickers

You need Python 3 with `reportlab segno fonttools brotli zxing-cpp pypdf numpy pillow`, and poppler's `pdftoppm`. The fonts are the theme's own (Archivo Black and Poppins), read from the website repo's `assets` folder.

```sh
python3 library_stickers.py games-2026-10-10.json stickers.pdf /path/to/Dice-Goblin-website/assets layout.json
python3 verify_stickers.py stickers.pdf games-2026-10-10.json
```

- Stickers come out in shelf-code order, so each shelf's games are together.
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
