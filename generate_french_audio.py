#!/usr/bin/env python3
"""
generate_french_audio.py
Phase 5: Generate French audio for all 1000 PTW concepts using Azure TTS.

Uses Azure Speech Services with fr-FR-HenriNeural voice (male, matching other languages).
Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION environment variables.
"""

import os
import json
import time
import hashlib
import requests
from pathlib import Path

BASE_DIR = Path(__file__).parent
FRENCH_TRANS_PATH = BASE_DIR / "french_translations.json"
CARDS_PATH = BASE_DIR / "dist_site" / "data" / "cards.json"
OUTPUT_DIR = BASE_DIR / "dist_site" / "assets" / "audio_french"
LOG_PATH = BASE_DIR / "logs" / "french_audio_log.txt"

# Azure configuration
AZURE_SPEECH_KEY = os.environ.get("AZURE_SPEECH_KEY", "").strip()
AZURE_SPEECH_REGION = os.environ.get("AZURE_SPEECH_REGION", "centralindia").strip()
AZURE_TTS_URL = f"https://{AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"

# French voice - male HenriNeural (consistent with other languages)
# EN: en-US-GuyNeural, JA: ja-JP-KeitaNeural, HI: hi-IN-MadhurNeural
FRENCH_VOICE = {
    "locale": "fr-FR",
    "name": "fr-FR-HenriNeural"
}

AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
MAX_RETRIES = 3
RATE_LIMIT_DELAY = 0.2  # seconds between requests


def validate_azure_config():
    """Validate Azure configuration."""
    if not AZURE_SPEECH_KEY:
        raise RuntimeError(
            "AZURE_SPEECH_KEY is not set. Set your Azure Speech Key "
            "as an environment variable before running."
        )


def text_hash(text: str) -> str:
    """Generate a short hash for text."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def synthesize_azure(text: str, output_path: Path) -> bool:
    """Synthesize speech using Azure TTS."""
    headers = {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": AZURE_OUTPUT_FORMAT,
        "User-Agent": "PTW-Generator"
    }

    ssml = f"""<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{FRENCH_VOICE["locale"]}'>
        <voice name='{FRENCH_VOICE["name"]}'>
            <prosody rate='-5%'>{text}</prosody>
        </voice>
    </speak>"""

    for attempt in range(MAX_RETRIES):
        try:
            response = requests.post(
                AZURE_TTS_URL,
                headers=headers,
                data=ssml.encode("utf-8"),
                timeout=30
            )

            if response.status_code == 200:
                output_path.parent.mkdir(parents=True, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(response.content)
                return True
            elif response.status_code == 429:
                # Rate limited - wait and retry
                wait_time = 2 ** (attempt + 1)
                print(f"  Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"  Error {response.status_code}: {response.text[:100]}")
                return False

        except Exception as e:
            print(f"  Attempt {attempt + 1} failed: {e}")
            time.sleep(1)

    return False


def main():
    print("=== French Audio Generator ===\n")

    # Check for Azure credentials
    if not AZURE_SPEECH_KEY:
        print("Warning: AZURE_SPEECH_KEY not set. Using placeholder mode.")
        print("To generate actual audio, set AZURE_SPEECH_KEY environment variable.")
        print("Skipping actual audio generation.\n")
        return

    validate_azure_config()

    # Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Load French translations
    print("Loading French translations...")
    with open(FRENCH_TRANS_PATH, 'r', encoding='utf-8') as f:
        french_trans = json.load(f)

    # Load cards
    with open(CARDS_PATH, 'r', encoding='utf-8') as f:
        cards = json.load(f)

    print(f"Processing {len(cards)} concepts...\n")

    generated = 0
    skipped = 0
    failed = 0

    log_entries = []

    for card in cards:
        concept_id = card['concept_id']
        trans = french_trans.get(concept_id, {})
        french = trans.get('french')

        if not french:
            skipped += 1
            continue

        output_path = OUTPUT_DIR / f"{concept_id}_fr.mp3"

        # Skip if already exists
        if output_path.exists():
            skipped += 1
            continue

        print(f"  {concept_id}: {french}...", end=" ")

        if synthesize_azure(french, output_path):
            print("✓")
            generated += 1
            log_entries.append(f"OK: {concept_id} - {french}")
        else:
            print("✗")
            failed += 1
            log_entries.append(f"FAIL: {concept_id} - {french}")

        time.sleep(RATE_LIMIT_DELAY)

    # Save log
    with open(LOG_PATH, 'w', encoding='utf-8') as f:
        f.write("\n".join(log_entries))

    print(f"\n=== Results ===")
    print(f"Generated: {generated}")
    print(f"Skipped: {skipped}")
    print(f"Failed: {failed}")
    print(f"Log saved to: {LOG_PATH}")


if __name__ == "__main__":
    main()
