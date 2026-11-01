#!/usr/bin/env python3
"""Generate real Microsoft Ryan MP3 files for the verified study cards.

Only the phrase and original English example are sent to Microsoft Edge TTS.
No book text, browser imports, personal progress, credentials or translations
are sent. This tool does not publish anything or modify another project.
Run with --check for an entirely offline manifest/hash/decoder validation.
"""
from __future__ import annotations

import argparse
import array
import asyncio
import hashlib
import importlib.metadata
import json
import math
import re
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
VOICE = "en-GB-RyanNeural"
RATE = "+0%"
EDGE_VERSION = "7.3.1"
MANIFEST = ROOT / "audio" / "manifest.json"


def read_cards():
    raw = DATA.read_text(encoding="utf-8")
    found = re.search(r"export const (?:BOOK_CARDS|DEMO_CARDS)\s*=\s*", raw)
    if not found: raise ValueError("No card export found")
    cards, _ = json.JSONDecoder().raw_decode(raw[found.end():])
    assert len({card["id"] for card in cards}) == len(cards), "Duplicate card ID"
    return cards


def expected_clips():
    unique = {}
    for card in read_cards():
        for text_field, file_field in [("phrase", "audioPhrase"), ("example", "audioExample")]:
            path = card[file_field]
            assert re.fullmatch(r"audio/[a-zA-Z0-9_-]+\.mp3", path)
            if path in unique and unique[path] != card[text_field]: raise ValueError("Conflicting audio texts")
            unique[path] = card[text_field]
    yield from unique.items()


def decode(path):
    import imageio_ffmpeg
    result = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-xerror",
         "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "24000",
         "-f", "f32le", "-"], capture_output=True, timeout=30, check=True,
    )
    if result.stderr.strip():
        raise ValueError(f"Decoder reported an error for {path.name}")
    samples = array.array("f", result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    duration = len(samples) / 24000
    rms = math.sqrt(sum(float(x) ** 2 for x in samples) / max(1, len(samples)))
    if not 0.2 < duration < 90 or rms < 0.0001:
        raise ValueError(f"Invalid duration or silent recording: {path.name}")
    return round(duration, 3)


def read_manifest():
    if not MANIFEST.exists():
        return {"version": 1, "provider": "Microsoft Edge TTS", "voice": VOICE,
                "rate": RATE, "edge_tts_version": EDGE_VERSION, "clips": {}}
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("voice") != VOICE or manifest.get("rate") != RATE:
        raise ValueError("Manifest voice/rate differs; refusing to mislabel audio")
    return manifest


def write_manifest(manifest):
    manifest["files"] = [
        {"path": relative, "bytes": (ROOT / relative).stat().st_size, "sha256": clip["sha256"]}
        for relative, clip in sorted(manifest["clips"].items())
    ]
    temporary = MANIFEST.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(MANIFEST)


def valid_existing(manifest, relative, text, strict=False):
    clip = manifest["clips"].get(relative)
    path = ROOT / relative
    good = (clip and path.is_file() and clip.get("text") == text
            and clip.get("voice") == VOICE and clip.get("rate") == RATE
            and clip.get("sha256") == hashlib.sha256(path.read_bytes()).hexdigest())
    if not good:
        if strict:
            raise ValueError(f"Missing or mismatched Ryan recording: {relative}")
        return False
    duration = decode(path)
    if abs(duration - clip.get("duration_seconds", 0)) > 0.05:
        raise ValueError(f"Duration mismatch for {relative}")
    return True


async def generate():
    import edge_tts
    import aiohttp
    if importlib.metadata.version("edge-tts") != EDGE_VERSION:
        raise RuntimeError(f"Install edge-tts=={EDGE_VERSION}")
    manifest = read_manifest()
    pending = [(path, text) for path, text in expected_clips()
               if not valid_existing(manifest, path, text)]
    if not pending:
        print(f"All {len(manifest['clips'])} Ryan clips already valid.")
        return
    voices = await asyncio.wait_for(edge_tts.list_voices(), timeout=30)
    if not any(voice.get("ShortName") == VOICE for voice in voices):
        raise RuntimeError(f"Required voice {VOICE} is not currently available")
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    manifest["voice_verified_at"] = datetime.now(timezone.utc).isoformat()
    write_manifest(manifest)
    # Use bounded concurrency and backoff. No alternate service,
    # voice substitution, certificate changes or private API credentials.
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def one(relative, text):
        async with semaphore:
            destination = ROOT / relative
            temporary = destination.with_suffix(".partial.mp3")
            try:
                for attempt in range(5):
                    try:
                        await asyncio.wait_for(
                            edge_tts.Communicate(text, VOICE, rate=RATE,
                                                 connect_timeout=15, receive_timeout=45).save(str(temporary)),
                            timeout=60,
                        )
                        break
                    except (edge_tts.exceptions.NoAudioReceived, asyncio.TimeoutError, ConnectionError, aiohttp.ClientConnectionError):
                        if attempt == 4:
                            raise
                        # Retry only transient empty streams and connection timeouts.
                        # Authentication/authorization/rate-limit errors are not retried.
                        temporary.unlink(missing_ok=True)
                        await asyncio.sleep(min(30, 3 * (2 ** attempt)))
                duration = decode(temporary)
                digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
                temporary.replace(destination)
                manifest["clips"][relative] = {
                    "text": text, "voice": VOICE, "rate": RATE, "sha256": digest,
                    "duration_seconds": duration,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                }
                write_manifest(manifest)
                print(f"Ready: {relative} ({duration}s)", flush=True)
            finally:
                temporary.unlink(missing_ok=True)

    await asyncio.gather(*(one(path, text) for path, text in pending))


def check(allow_extra=False, prune_manifest=False):
    if allow_extra and prune_manifest:
        raise ValueError("Choose either batch checking or final manifest pruning")
    manifest = read_manifest()
    expected = list(expected_clips())
    expected_paths = {path for path, _ in expected}
    if not expected_paths:
        raise ValueError("No expected audio clips; refusing an empty check or prune")
    for relative, text in expected:
        valid_existing(manifest, relative, text, strict=True)
    extras = set(manifest["clips"]) - expected_paths
    if prune_manifest:
        # Only run after the final full card selection is ready and every required
        # clip has passed validation. Keep unused MP3 files for reversible recovery.
        # Do not run this command concurrently with an active generator.
        manifest = {**manifest, "clips": {
            path: manifest["clips"][path] for path in sorted(expected_paths)
        }}
        write_manifest(manifest)
    elif extras and not allow_extra:
        raise ValueError("Manifest contains unexpected clips")
    expected_files = [
        {"path": relative, "bytes": (ROOT / relative).stat().st_size, "sha256": clip["sha256"]}
        for relative, clip in sorted(manifest["clips"].items())
    ]
    if manifest.get("files") != expected_files:
        raise ValueError("Offline-cache file manifest differs from verified clips")
    print(f"PASS: {len(expected)} real Ryan MP3 files; text, voice, SHA-256, duration and non-silent decoding verified.")
    if prune_manifest:
        print(f"Final manifest: {len(expected)} clips; {len(extras)} extra entries removed; MP3 files retained.")
    elif extras:
        print(f"Batch check: {len(extras)} other manifest entries retained; their audio was not checked in this batch.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Offline MP3 and manifest verification")
    parser.add_argument("--data", type=Path, default=ROOT / "data.js")
    parser.add_argument("--concurrency", type=int, choices=[1,2,3,6], default=2)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--allow-extra", action="store_true",
                           help="Allow other batches in the shared manifest; validate this data selection")
    selection.add_argument("--prune-manifest", action="store_true",
                           help="Offline: verify final data selection, then atomically trim only the manifest; retain MP3 files")
    args = parser.parse_args()
    DATA = args.data
    CONCURRENCY = args.concurrency
    try:
        if not args.check and not args.prune_manifest:
            asyncio.run(generate())
        check(allow_extra=args.allow_extra, prune_manifest=args.prune_manifest)
    except Exception as error:
        print(f"Ryan audio failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
