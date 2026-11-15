# clipstack

Free, open source split-screen vertical clip editor. Turns a 16:9 gameplay clip into a
9:16 video with the gameplay on top and your facecam below, plus text, emoji and sped-up
sections. Runs entirely in the browser: no upload, no watermark, no account.

Live at https://games.chanceitstudio.com/clipstack/

## Credits

- [Mediabunny](https://mediabunny.dev) 1.66.0 and its AAC encoder (MPL-2.0), in `vendor/mediabunny/`
- Bangers font (SIL OFL), in `fonts/`
- [Noto Color Emoji](https://github.com/googlefonts/noto-emoji) by Google (Apache-2.0), in `vendor/noto-emoji/`
- [emojibase-data](https://github.com/milesj/emojibase) (MIT) for emoji names and search words

`tools/build-emoji.mjs` rebuilds the emoji files when Noto or Unicode adds new ones.

## License

MIT, Chance IT Studio LLC. See `LICENSE`.
