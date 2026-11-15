# Emoji assets

- `svg/`: Google Noto Color Emoji SVGs (https://github.com/googlefonts/noto-emoji, 2D/svg),
  Apache License 2.0, minified with svgo. File names are the codepoints in hex, joined by `_`.
- `index.json`: names, keywords, groups and skin tones from emojibase-data
  (https://github.com/milesj/emojibase, MIT), built on Unicode and CLDR data.
- Rebuild with `tools/build-emoji.mjs`.
