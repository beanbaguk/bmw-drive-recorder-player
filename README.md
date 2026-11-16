# BMW Drive Recorder Player

A free, open-source tool for BMW enthusiasts. Convert a BMW Drive Recorder USB export into an H.264 MP4 with recorded speed, date, time, GPS coordinates, and a moving route marker.

This independent project is not affiliated with or endorsed by BMW. The BMW name identifies the compatible recording format.

## Open or download

| Choose how to use it | |
| --- | --- |
| **Web or Chrome app** | [Open the free player](https://beanbaguk.github.io/bmw-drive-recorder-player/). On desktop Chrome, use **Get the app** for installation instructions. |
| **Mac with Apple Silicon** | [Download for Mac (.dmg)](https://github.com/beanbaguk/bmw-drive-recorder-player/releases/download/v1.1.0/BMW-Drive-Recorder-Player-1.1.0-mac-arm64.dmg). This build is unnotarized and macOS may block it. |
| **Windows 64-bit** | [Download for Windows (.exe)](https://github.com/beanbaguk/bmw-drive-recorder-player/releases/download/v1.1.0/BMW-Drive-Recorder-Player-1.1.0-windows-x64-setup.exe). The unsigned installer may show a security warning. |

[Release notes and file checksums](https://github.com/beanbaguk/bmw-drive-recorder-player/releases/tag/v1.1.0)

## Use the player

1. Export a Drive Recorder recording from the vehicle to a USB drive.
2. Drop the export folder into the player, or select one `.ts` video with its JSON, or one to four camera `.mp4` videos with their matching XML. Keep the original camera filenames; select either the normal or raw set, not both.
3. Choose **km/h** or **mph**, and **European**, **US**, or **As recorded** date formatting. If a slash date is ambiguous, choose its original month/day or day/month order. This does not change its time zone.
4. Optionally add a **car model or name** (36 characters), **registration** (14), and **name or nickname** (24). Empty fields and their labels are omitted from the video. Text shrinks slightly, wraps where appropriate, and is shortened with an ellipsis if needed to keep it within its row.
5. Enable **Include VIN in video** if wanted. This starts off for each recording and is unavailable when the source has no valid VIN.
6. Select **Convert to MP4**, play the result, then **Download MP4**.

Conversion and playback run on your computer. The GPS route is drawn locally. The optional **Include road map** setting requests background tiles from OpenFreeMap, which reveals the approximate map area to the provider. The app never uploads source files or stores a copy of the rendered video online. Optional identity text is not saved between app sessions; **Clear recording** clears it.

The interface and overlay labels use Spanish when the browser or desktop system uses Spanish as its primary language, and English otherwise. An English (US) locale initially selects mph and US display; other locales initially select km/h and European display. Both settings can be changed freely.

## Recording compatibility

- **TS + JSON:** iDrive 7 `velocity` (km/h), and iDrive 8/8.5 `velocity_KM/H` and `velocity_MP/H` (including mph stored as text). A source value in the selected unit is preserved; conversion using 1 mile = 1.609344 km is used only when that unit is absent. VIN is optional.
- **Camera MP4 + XML:** BMW `<DATA><LOG><ENTRY>` metadata with `ID`, `DATE_UTC`, `TIME_UTC`, `VELOCITY_KMH`, `LATITUDE`, and `LONGITUDE`. Sparse IDs determine timing. The four camera positions are composed into a grid without stretching or cropping; omitted cameras are labelled. Original English, German, Spanish and French camera-position names are recognized. Camera filenames and XML must share an export prefix, and camera start times and durations must agree within 0.15 seconds.
- **Dates:** dotted day/month/year, slash month/day/year or day/month/year, ISO dates, and 12-hour or 24-hour clocks. Ambiguous slash dates require an explicit source order. Recorded clock values are never shifted to the viewer's timezone; XML clocks are marked UTC.

Compatibility is based on the actual files, not the iDrive version alone. iDrive 9 has not been verified with a representative export. Separate camera MP4 output is silent, matching the BMW camera fixtures tested here.

Validation includes unit tests, browser conversion/playback/seeking/download, and packaged Mac and Windows app checks. Real iDrive 7 and 8.5 TS exports are tested locally; public CI uses generated footage and synthetic metadata. The MP4/XML importer is also tested locally against the public sample in [drive-recorder-composer](https://github.com/domajstorovic/drive-recorder-composer/tree/master/tests/fixtures/sample). No owner's recordings, VIN or route are included in the repository or CI.

## Build from source

Install Node.js 24, then run `npm ci`. The same HTML, CSS, and JavaScript are used by the website and the Electron desktop application.

| Command | Result |
| --- | --- |
| `npm test` | Check JSON/XML telemetry, dates, units, camera grouping, optional text, and validation |
| `npm run desktop` | Build and open a local development copy in Electron |
| `npm run package:mac` | Apple Silicon `.app` and `.dmg` on macOS |
| `npm run package:windows` | 64-bit Windows setup `.exe` on Windows |
| `npm run build` | Build the static site in `dist/` |

Desktop packages appear in `release/`. Local packages are intended for testing. Public Mac distribution requires Developer ID signing and notarization. A Windows publisher certificate can be configured before building a signed installer.

The recorder's date and time retain their original time zone. Verification checks the file formats and recording durations. Pair files from the same export.

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
DMG="release/BMW-Drive-Recorder-Player-1.1.0-mac-arm64.dmg"
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
