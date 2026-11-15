# BMW Drive Recorder Player

A free, open-source tool for BMW enthusiasts. Convert a BMW Drive Recorder USB export into an H.264 MP4 with recorded speed, date, time, GPS coordinates, and a moving route marker.

This independent project is not affiliated with or endorsed by BMW. The BMW name identifies the compatible recording format.

## Use the player

1. Export a Drive Recorder recording from the vehicle to a USB drive.
2. Drop the recording folder into the player or select the matching `.ts` video and `Metadata.json`.
3. Enable **Include VIN in video** if you want the vehicle ID visible in the MP4. The option starts off for each recording.
4. Select **Convert to MP4**, play the result, then select **Download MP4** to save it.

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

## Notarize a Mac release

For direct downloads, [enroll in the Apple Developer Program](https://developer.apple.com/programs/enroll/) and install a [Developer ID Application certificate](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) on the build Mac. Use its identity hash from `security find-identity -v -p codesigning`. Save your Apple Account, Team ID, and app-specific password in a local Keychain profile using the interactive `notarytool` prompts.

```sh
xcrun notarytool store-credentials "drive-recorder-notary"
npm run package:mac -- \
  --config.mac.identity="DEVELOPER_ID_APPLICATION_CERTIFICATE_HASH" \
  --config.forceCodeSigning=true --config.mac.notarize=false --config.dmg.sign=true
```

Submit the signed disk image from `release/`. Replace the filename below with the one from your build.

```sh
DMG="release/BMW-Drive-Recorder-Player-1.0.1-mac-arm64.dmg"
xcrun notarytool submit "$DMG" --keychain-profile "drive-recorder-notary" --wait
```

When Apple returns `Accepted`, attach the ticket and verify the disk image before uploading it.

```sh
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
```

[Apple’s notarization and packaging instructions](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution) cover the signing and ticket checks. Keep the certificate private key and credentials in Keychain.

## License

The project source is licensed under [GNU GPL v3](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.txt) for the bundled libraries, font, and map sources.
