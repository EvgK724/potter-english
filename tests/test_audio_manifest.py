"""Isolated manifest-selection tests; never touch the real audio directory or TTS."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "generate_audio", Path(__file__).resolve().parents[1] / "scripts" / "generate_audio.py"
)
audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audio)


class ManifestSelectionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="potter-audio-test-")
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        (root / "audio").mkdir()
        for name, value in [("ROOT", root), ("MANIFEST", root / "audio" / "manifest.json")]:
            manager = patch.object(audio, name, value)
            manager.start()
            self.addCleanup(manager.stop)
        self.data = root / "data.js"
        manager = patch.object(audio, "DATA", self.data, create=True)
        manager.start()
        self.addCleanup(manager.stop)
        manager = patch.object(audio, "decode", return_value=1.5)
        manager.start()
        self.addCleanup(manager.stop)
        self.cards = [{"id": "one", "phrase": "look after", "example": "We look after the garden.",
                       "audioPhrase": "audio/phrase.mp3", "audioExample": "audio/example.mp3"}]
        self.save_cards()
        self.manifest = audio.read_manifest()
        for relative, text in [*audio.expected_clips(), ("audio/extra.mp3", "another batch")]:
            payload = text.encode()
            (root / relative).write_bytes(payload)
            self.manifest["clips"][relative] = {
                "text": text, "voice": audio.VOICE, "rate": audio.RATE,
                "sha256": hashlib.sha256(payload).hexdigest(), "duration_seconds": 1.5,
            }
        audio.write_manifest(self.manifest)

    def save_cards(self):
        self.data.write_text("export const BOOK_CARDS = " + json.dumps(self.cards) + ";")

    def test_batch_check_preserves_manifest(self):
        before = audio.MANIFEST.read_bytes()
        audio.check(allow_extra=True)
        self.assertEqual(before, audio.MANIFEST.read_bytes())

    def test_exact_check_rejects_extra_entries(self):
        with self.assertRaisesRegex(ValueError, "unexpected"):
            audio.check()

    def test_final_prune_removes_only_extra_manifest_entries(self):
        audio.check(prune_manifest=True)
        result = audio.read_manifest()
        self.assertEqual(set(result["clips"]), {"audio/phrase.mp3", "audio/example.mp3"})
        self.assertTrue((audio.ROOT / "audio/extra.mp3").is_file())
        audio.check()

    def test_incomplete_final_selection_does_not_prune(self):
        (audio.ROOT / "audio/example.mp3").unlink()
        before = audio.MANIFEST.read_bytes()
        with self.assertRaisesRegex(ValueError, "Missing or mismatched"):
            audio.check(prune_manifest=True)
        self.assertEqual(before, audio.MANIFEST.read_bytes())

    def test_empty_selection_cannot_prune_manifest(self):
        self.cards = []
        self.save_cards()
        before = audio.MANIFEST.read_bytes()
        with self.assertRaisesRegex(ValueError, "No expected"):
            audio.check(prune_manifest=True)
        self.assertEqual(before, audio.MANIFEST.read_bytes())

    def test_shared_phrase_path_is_generated_once(self):
        self.cards.append({**self.cards[0], "id": "two"})
        self.save_cards()
        self.assertEqual(len(list(audio.expected_clips())), 2)
        self.cards[1]["phrase"] = "different text"
        self.save_cards()
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            list(audio.expected_clips())


if __name__ == "__main__":
    unittest.main()
