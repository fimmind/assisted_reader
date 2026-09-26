"""WordNet filtering adapter for the released Glite LENS seed-42 checkpoint."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from xml.etree import ElementTree

import numpy as np
import torch
from transformers import AutoConfig, AutoModel, AutoTokenizer

from rankers import (
    EMBEDDING_CACHE_ROOT,
    MODEL_ROOT,
    ROOT,
    BenchmarkScores,
    Ranker,
    model_revision,
    target_span,
    unique_inputs,
)


NAME = "glite-lens"
CONTEXT_MAX_LENGTH = 324
GLOSS_MAX_LENGTH = 512
CONTEXT_BATCH_SIZE = 8
GLOSS_BATCH_SIZE = 16
POS_LABELS = {
    "noun": "noun",
    "verb": "verb",
    "adjective": "adj",
    "adverb": "adv",
}


def _sentence_text(sentence: ElementTree.Element) -> str:
    return " ".join((token.text or "").strip() for token in sentence)


def _target_start(sentence: ElementTree.Element, target: ElementTree.Element) -> int:
    target_index = list(sentence).index(target)
    preceding = [((token.text or "").strip()) for token in list(sentence)[:target_index]]
    return len(" ".join(preceding)) + int(target_index > 0)


def load_document_contexts(dataset: str) -> dict[str, tuple[str, int, str]]:
    """Build the released five-previous/one-next window within each document."""
    name = dataset.removeprefix("raganato-")
    source = (
        ROOT / "data" / "raw" / "WSD_Evaluation_Framework"
        / "Evaluation_Datasets" / name / f"{name}.data.xml"
    )
    if not source.is_file():
        raise FileNotFoundError(f"Raganato XML needed for Glite LENS is missing: {source}")
    contexts: dict[str, tuple[str, int, str]] = {}
    root = ElementTree.parse(source).getroot()
    for document in root.iter("text"):
        sentences = list(document.iter("sentence"))
        texts = [_sentence_text(sentence) for sentence in sentences]
        for sentence_index, sentence in enumerate(sentences):
            first = max(0, sentence_index - 5)
            last = min(len(sentences), sentence_index + 2)
            context = " ".join(texts[first:last])
            prefix_length = sum(len(texts[index]) + 1 for index in range(first, sentence_index))
            for target in sentence.iter("instance"):
                instance_id = target.attrib["id"]
                if instance_id in contexts:
                    raise ValueError(f"Duplicate Raganato instance ID: {instance_id}")
                start = prefix_length + _target_start(sentence, target)
                surface = (target.text or "").strip()
                if context[start:start + len(surface)] != surface:
                    raise ValueError(f"Glite LENS context offset mismatch: id={instance_id}")
                contexts[instance_id] = (context, start, texts[sentence_index])
    return contexts


def context_input(
    example: dict,
    document_contexts: dict[str, tuple[str, int, str]] | None,
) -> tuple[str, int, int]:
    if str(example["dataset"]).startswith("raganato-"):
        if document_contexts is None or example["id"] not in document_contexts:
            raise KeyError(f"Glite LENS document context is missing: id={example['id']}")
        text, start, sentence = document_contexts[example["id"]]
        if sentence != example["context"]:
            raise ValueError(f"Glite LENS sentence differs from benchmark: id={example['id']}")
    else:
        text = example["context"]
        start, _ = target_span(example)
    end = start + len(example["target"])
    if text[start:end] != example["target"]:
        raise ValueError(f"Glite LENS target span mismatch: id={example['id']}")
    return text, start, end


def structured_gloss(example: dict, candidate: dict) -> str:
    """Render the release's headword/POS/definition/synonym/example fields."""
    from nltk.corpus import wordnet as wn

    synset = wn.synset(candidate["sense_id"])
    if synset.definition() != candidate["gloss"]:
        raise ValueError(f"WordNet gloss differs from benchmark: sense={candidate['sense_id']}")
    lemma = str(example["lemma"])
    normalized_headword = lemma.replace("_", " ").strip().lower()
    seen: set[str] = set()
    synonyms: list[str] = []
    for entry in synset.lemmas():
        synonym = entry.name().replace("_", " ").strip()
        normalized = synonym.lower()
        if normalized == normalized_headword or normalized in seen:
            continue
        seen.add(normalized)
        synonyms.append(synonym)
    examples = "; ".join(example.strip() for example in synset.examples())
    pos = POS_LABELS[str(example["pos"])]
    return (
        f"headword={lemma} | pos={pos} | definition={candidate['gloss']} | "
        f"synonyms={{{', '.join(synonyms)}}} | examples={{{examples}}}"
    )


def encode_context(tokenizer: object, text: str, start: int, end: int) -> tuple[list[int], list[float]]:
    """Tokenize and retain the target-centered 324-token window from the release."""
    encoded = tokenizer(
        text,
        add_special_tokens=False,
        return_offsets_mapping=True,
        truncation=False,
    )
    token_ids = encoded["input_ids"]
    offsets = encoded["offset_mapping"]
    target_indices = [
        index for index, (left, right) in enumerate(offsets)
        if left < end and right > start and left != right
    ]
    if not target_indices:
        raise ValueError(f"Target did not align to tokenizer offsets: text={text!r} start={start} end={end}")
    usable = CONTEXT_MAX_LENGTH - 2
    first = 0
    if len(token_ids) > usable:
        first = max(0, target_indices[0] - int(usable * 0.75))
        if target_indices[-1] >= first + usable:
            first = target_indices[-1] - usable + 1
        first = min(first, len(token_ids) - usable)
    sliced_ids = token_ids[first:first + usable]
    sliced_offsets = offsets[first:first + usable]
    mask = [float(left < end and right > start) for left, right in sliced_offsets]
    if not any(mask):
        raise ValueError(f"Target was truncated from Glite LENS context: text={text!r}")
    return [tokenizer.cls_token_id, *sliced_ids, tokenizer.sep_token_id], [0.0, *mask, 0.0]


class GliteLensRanker(Ranker):
    name = NAME
    model_cache_name = NAME

    def __init__(self) -> None:
        import nltk

        nltk.data.path.insert(0, str(ROOT / ".cache" / "nltk"))
        model_root = MODEL_ROOT / NAME
        base_root = MODEL_ROOT / "glite-lens-base"
        checkpoint = model_root / "best_model.ckpt"
        if not checkpoint.is_file() or not (base_root / "config.json").is_file():
            raise FileNotFoundError(
                f"Glite LENS checkpoint or base tokenizer is missing: checkpoint={checkpoint} base={base_root}"
            )
        self.tokenizer = AutoTokenizer.from_pretrained(str(base_root), local_files_only=True)
        if not self.tokenizer.is_fast:
            raise ValueError(f"Glite LENS requires a fast tokenizer: path={base_root}")
        config = AutoConfig.from_pretrained(str(base_root), local_files_only=True)
        self.context_encoder = AutoModel.from_config(config)
        self.gloss_encoder = AutoModel.from_config(config)
        payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
        state = payload["model_state_dict"]
        context_weights = {
            key.removeprefix("context_encoder."): value
            for key, value in state.items() if key.startswith("context_encoder.")
        }
        gloss_weights = {
            key.removeprefix("gloss_encoder."): value
            for key, value in state.items() if key.startswith("gloss_encoder.")
        }
        self.context_encoder.load_state_dict(context_weights, strict=True)
        self.gloss_encoder.load_state_dict(gloss_weights, strict=True)
        self.context_encoder.eval()
        self.gloss_encoder.eval()
        self.hidden_size = int(config.hidden_size)
        torch.set_num_threads(4)

    def encode_glosses(self, texts: list[str]) -> np.ndarray:
        vectors: list[np.ndarray] = []
        for offset in range(0, len(texts), GLOSS_BATCH_SIZE):
            if len(texts) > 1024 and offset % 1024 == 0:
                print(json.dumps({"stage": "gloss_encoding", "completed": offset, "total": len(texts)}), flush=True)
            encoded = self.tokenizer(
                texts[offset:offset + GLOSS_BATCH_SIZE],
                padding=True,
                truncation=True,
                max_length=GLOSS_MAX_LENGTH,
                return_tensors="pt",
            )
            with torch.inference_mode():
                hidden = self.gloss_encoder(**encoded).last_hidden_state[:, 0, :]
            vectors.append(hidden.numpy())
        if not vectors:
            raise ValueError("Cannot encode an empty Glite LENS gloss list")
        return np.concatenate(vectors)

    def encode_contexts(self, inputs: list[tuple[str, int, int]]) -> np.ndarray:
        vectors: list[np.ndarray] = []
        for offset in range(0, len(inputs), CONTEXT_BATCH_SIZE):
            if len(inputs) > 1024 and offset % 1024 == 0:
                print(json.dumps({"stage": "context_encoding", "completed": offset, "total": len(inputs)}), flush=True)
            batch = [encode_context(self.tokenizer, *item) for item in inputs[offset:offset + CONTEXT_BATCH_SIZE]]
            maximum = max(len(ids) for ids, _ in batch)
            ids = torch.full((len(batch), maximum), self.tokenizer.pad_token_id, dtype=torch.long)
            attention = torch.zeros((len(batch), maximum), dtype=torch.long)
            targets = torch.zeros((len(batch), maximum), dtype=torch.float)
            for row, (tokens, mask) in enumerate(batch):
                length = len(tokens)
                ids[row, :length] = torch.tensor(tokens, dtype=torch.long)
                attention[row, :length] = 1
                targets[row, :length] = torch.tensor(mask, dtype=torch.float)
            with torch.inference_mode():
                hidden = self.context_encoder(input_ids=ids, attention_mask=attention).last_hidden_state
                target_mask = targets.unsqueeze(-1)
                pooled = (hidden * target_mask).sum(dim=1) / target_mask.sum(dim=1).clamp(min=1)
            vectors.append(pooled.numpy())
        if not vectors:
            raise ValueError("Cannot encode an empty Glite LENS context list")
        return np.concatenate(vectors)

    def score(self, example: dict) -> list[float]:
        dataset = str(example["dataset"])
        contexts = load_document_contexts(dataset) if dataset.startswith("raganato-") else None
        input_value = context_input(example, contexts)
        context = self.encode_contexts([input_value])[0]
        glosses = self.encode_glosses([structured_gloss(example, candidate) for candidate in example["candidates"]])
        return (glosses @ context).tolist()

    def benchmark_score_many(self, examples: list[dict]) -> BenchmarkScores:
        datasets = {str(example["dataset"]) for example in examples if str(example["dataset"]).startswith("raganato-")}
        document_contexts = {dataset: load_document_contexts(dataset) for dataset in datasets}
        contexts = [context_input(example, document_contexts.get(str(example["dataset"]))) for example in examples]
        glosses = [structured_gloss(example, candidate) for example in examples for candidate in example["candidates"]]
        unique_glosses, inverse = unique_inputs(glosses)
        cache_key = hashlib.sha256(json.dumps({
            "model_revision": model_revision(NAME),
            "base_revision": model_revision("glite-lens-base"),
            "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "glosses": unique_glosses,
        }, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()
        cache_path = EMBEDDING_CACHE_ROOT / NAME / f"{cache_key}.npy"
        preparation_started = time.perf_counter()
        cache_hit = cache_path.is_file()
        if cache_hit:
            unique_vectors = np.load(cache_path, allow_pickle=False)
        else:
            unique_vectors = self.encode_glosses(unique_glosses)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = cache_path.with_suffix(".tmp.npy")
            np.save(temporary, unique_vectors, allow_pickle=False)
            temporary.replace(cache_path)
        if unique_vectors.shape != (len(unique_glosses), self.hidden_size):
            raise ValueError(f"Invalid Glite LENS gloss cache: path={cache_path} shape={unique_vectors.shape}")
        preparation_ms = (time.perf_counter() - preparation_started) * 1000

        online_started = time.perf_counter()
        context_vectors = self.encode_contexts(contexts)
        gloss_vectors = unique_vectors[np.asarray(inverse)]
        scores: list[list[float]] = []
        position = 0
        for example, context in zip(examples, context_vectors):
            count = len(example["candidates"])
            scores.append((gloss_vectors[position:position + count] @ context).tolist())
            position += count
        online_ms = (time.perf_counter() - online_started) * 1000
        return BenchmarkScores(
            scores=scores,
            preparation_ms=preparation_ms,
            online_ms=online_ms,
            definition_inputs=len(glosses),
            unique_definition_inputs=len(unique_glosses),
            definition_cache_hit=cache_hit,
        )
