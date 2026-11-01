# Ryan audio

The study pack uses the synthetic British English Microsoft voice
`en-GB-RyanNeural`. Each card has separate MP3 recordings for its phrase and its
original English example. These are teaching examples, not book or audiobook
excerpts. The recordings are ordinary static assets; playing them does not need
an Azure account, a secret, or the presence of Ryan in the device's system voices.

Microsoft lists the voice in its [official voice catalogue](https://learn.microsoft.com/azure/cognitive-services/speech-service/language-support?tabs=tts).
The generator uses the standard [edge-tts client](https://github.com/rany2/edge-tts),
checks the live voice list before generating, and does not substitute another
voice. Availability of the online generation service can change.

```sh
python3 -m venv .venv-audio
.venv-audio/bin/python -m pip install -r scripts/requirements-audio.txt
.venv-audio/bin/python scripts/generate_audio.py
.venv-audio/bin/python scripts/generate_audio.py --check
```

Generation sends only the English `phrase` and `example` fields from `data.js`
to Microsoft Edge TTS. No user-imported book, local progress or Russian text is
sent. Existing valid clips are reused. A failed generation exits nonzero; it does
not create silent replacements or relabel browser speech as Ryan.

`audio/manifest.json` records the exact text, voice, rate, generation time,
SHA-256, byte size and decoded duration. `--check` runs offline and validates
every unique required file, including non-silent PCM decoding with FFmpeg. The
app's offline cache uses the `files` array (`path`, `bytes`, `sha256`). Identical
phrase text may reuse a shared MP3 path; conflicting texts for one path fail.

For incremental batches, pass `--data PATH_TO_BATCH.js --allow-extra` to
generation or to `--check`. This verifies the batch and preserves entries for
other batches. Use only one generator process with the shared audio directory;
`--concurrency 1`, `2` or `3` controls requests inside that process.

After the final card selection is complete and generation has stopped, run:

```sh
.venv-audio/bin/python scripts/generate_audio.py --data data.js --prune-manifest
.venv-audio/bin/python scripts/generate_audio.py --data data.js --check
```

Pruning is an offline operation. It first verifies every selected clip, then
atomically removes only surplus manifest entries. It keeps surplus MP3 files on
disk for recovery. Missing, incorrect or empty final selections do not change
the manifest. Never prune per batch or while generation is active. A final
strict check rejects any extra manifest entries, so publication and offline
caching use exactly the final card selection.
