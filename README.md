# BMW Drive Recorder Player

A free, open-source tool for BMW enthusiasts. Convert a BMW Drive Recorder USB export into an H.264 MP4 with recorded speed, date, time, GPS coordinates, and a moving route marker.

This independent project is not affiliated with or endorsed by BMW. The BMW name identifies the compatible recording format.

## Use the player

1. Export a Drive Recorder recording from the vehicle to a USB drive.
2. Drop the recording folder into the player or select the matching `.ts` video and `Metadata.json`.
3. Select **Convert to MP4**, play the result, then select **Download MP4** to save it.

Conversion and playback run on your computer. The GPS route is drawn locally. The optional **Include road map** setting requests background tiles from OpenFreeMap, which reveals the approximate map area to the provider. The app never uploads the source files or stores a copy of the rendered video online.

## Build from source

Install Node.js 24, then run `npm ci`. The same HTML, CSS, and JavaScript are used by the website and the Electron desktop application.

| Command | Result |
| --- | --- |
| `npm run desktop` | Build and open a local development copy in Electron |
| `npm run package:mac` | Apple Silicon `.app` and `.dmg` on macOS |
| `npm run package:windows` | 64-bit Windows setup `.exe` on Windows |
| `npm run build` | Build the static site in `dist/` |

Desktop packages appear in `release/`. Local packages are intended for testing. Public Mac distribution requires Developer ID signing and notarization. A Windows publisher certificate can be configured before building a signed installer.

The recorder's date and time are displayed as recorded. Verification checks the file formats and recording durations. Pair files from the same export.

## License

The project source is licensed under [GNU GPL v3](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.txt) for the bundled libraries, font, and map sources.
