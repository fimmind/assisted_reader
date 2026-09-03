from __future__ import annotations

import argparse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
# The canonical host's HTTPS certificate is presently invalid; the project and
# its published reproduction instructions use this HTTP endpoint.
RAGANATO_URL = "http://lcl.uniroma1.it/wsdeval/data/WSD_Evaluation_Framework.zip"
COARSE_URL = "https://github.com/danlou/bert-disambiguation/archive/refs/heads/master.zip"
WORDNET_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip"


def download(url: str, destination: Path) -> None:
    if destination.exists() and destination.stat().st_size > 0:
        print(f"already downloaded: {destination.name}")
        return
    destination.unlink(missing_ok=True)
    print(f"downloading: {url}")
    urllib.request.urlretrieve(url, destination)


def extract(archive: Path, destination: Path, expected: str) -> None:
    if (destination / expected).exists():
        print(f"already extracted: {archive.name}")
        return
    with zipfile.ZipFile(archive) as source:
        source.extractall(destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-wordnet", action="store_true")
    args = parser.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    raganato = RAW / "WSD_Evaluation_Framework.zip"
    coarse = RAW / "CoarseWSD-20.zip"
    download(RAGANATO_URL, raganato)
    extract(raganato, RAW, "WSD_Evaluation_Framework")
    download(COARSE_URL, coarse)
    extract(coarse, RAW, "bert-disambiguation-master")
    if not args.skip_wordnet:
        nltk_root = ROOT / ".cache" / "nltk" / "corpora"
        nltk_root.mkdir(parents=True, exist_ok=True)
        wordnet = nltk_root / "wordnet.zip"
        download(WORDNET_URL, wordnet)


if __name__ == "__main__":
    main()
