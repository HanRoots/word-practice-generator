#!/usr/bin/env python3
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET


NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
TONE_RE = re.compile(r"[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]", re.I)
CJK_RE = re.compile(r"[\u3400-\u9fff]")
PINYIN_RE = re.compile(r"[A-Za-züÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ\s]+")


def cell_text(el):
    return "".join(t.text or "" for t in el.findall(".//w:t", NS)).strip()


def docx_tables(path):
    with ZipFile(path) as zf:
        xml = zf.read("word/document.xml")
    root = ET.fromstring(xml)
    tables = []
    for tbl in root.findall(".//w:tbl", NS):
        rows = []
        for tr in tbl.findall("./w:tr", NS):
            cells = [cell_text(tc) for tc in tr.findall("./w:tc", NS)]
            if any(cells):
                rows.append(cells)
        if rows:
            tables.append(rows)
    return tables


def first_cjk(value):
    match = CJK_RE.search(value or "")
    return match.group(0) if match else ""


def cjk_chars(value):
    return CJK_RE.findall(value or "")


def clean_pinyin(value):
    value = re.sub(r"\s+", " ", value or "").strip()
    return value.replace("Ü", "ü")


def has_pinyin(value):
    return bool(PINYIN_RE.search(value or ""))


def has_tone(value):
    if TONE_RE.search(value or ""):
        return True
    return any(s in {"de", "le", "zi", "shang", "men", "ma", "ba"} for s in clean_pinyin(value).split())


def parse_grade(value, fallback):
    text = value or fallback
    grade_match = re.search(r"([一二三四五六]年级)", text)
    volume_match = re.search(r"([上下])册?", text)
    grade = grade_match.group(1) if grade_match else fallback[:3]
    volume = f"{volume_match.group(1)}册" if volume_match else ""
    label = f"{grade}{volume}" if volume else grade
    return grade, volume, label


def source_grade_from_file(path):
    name = path.stem
    grade, volume, label = parse_grade(name, name)
    return grade, volume, label


def split_confusables(value):
    value = (value or "").replace("同音：", "").replace("同音:", "")
    if not value or value.strip() in {"—", "-", "无"}:
        return []
    chars = []
    for part in re.split(r"[、,，;/；\s]+", value):
        for ch in cjk_chars(part):
            if ch not in chars:
                chars.append(ch)
    return chars[:8]


def parse_word_segments(value):
    text = (value or "").strip()
    if not text or text in {"—", "-"}:
        return []
    segments = [item.strip() for item in re.split(r"[；;]", text) if item.strip()]
    words = []
    for segment in segments:
        segment = segment.strip("。；; ")
        match = re.match(r"^([\u3400-\u9fff]{1,8})[（(]([^）)]+)[）)]$", segment)
        if not match:
            match = re.match(r"^([\u3400-\u9fff]{1,8})\s+(.+)$", segment)
        if not match:
            continue
        word = match.group(1).strip()
        pinyin = clean_pinyin(match.group(2))
        if word and pinyin and has_pinyin(pinyin):
            words.append({"word": word, "pinyin": pinyin})
    return words


def is_single_char_entry(value):
    return len(cjk_chars(value)) == 1 and first_cjk(value) == (value or "").strip()


def normalize_row(cells, width):
    return cells + [""] * max(0, width - len(cells))


def add_char_entry(entries, item):
    key = (item["grade"], item["volume"], item["char"])
    current = entries.get(key)
    if not current:
        entries[key] = item
        return
    current["pinyin"] = current["pinyin"] if has_tone(current.get("pinyin", "")) else item["pinyin"]
    existing_words = {word["word"] for word in current["words"]}
    for word in item["words"]:
        if word["word"] not in existing_words:
            current["words"].append(word)
            existing_words.add(word["word"])
    existing_confusables = set(current["confusables"])
    for char in item["confusables"]:
        if char not in existing_confusables and char != item["char"]:
            current["confusables"].append(char)
            existing_confusables.add(char)


def add_word_entry(entries, item):
    key = (item["grade"], item["volume"], item["word"])
    if key not in entries:
        entries[key] = item


def parse_tables(path, char_entries, word_entries, source_summary):
    default_grade, default_volume, default_label = source_grade_from_file(path)
    tables = docx_tables(path)
    source_summary.append({"file": path.name, "tables": len(tables)})
    for table_index, rows in enumerate(tables, 1):
        if not rows:
            continue
        header = rows[0]
        has_grade_col = header and header[0] == "年级"
        for row_index, raw_cells in enumerate(rows[1:], 1):
            cells = normalize_row(raw_cells, 5)
            if has_grade_col:
                grade, volume, grade_label = parse_grade(cells[0], default_label)
                if len(cells) >= 5 and is_single_char_entry(cells[1]):
                    char = first_cjk(cells[1])
                    pinyin = clean_pinyin(cells[2])
                    add_char_entry(char_entries, {
                        "grade": grade,
                        "volume": volume,
                        "sourceGrade": grade_label,
                        "char": char,
                        "pinyin": pinyin,
                        "words": parse_word_segments(cells[3]),
                        "confusables": [c for c in split_confusables(cells[4]) if c != char],
                        "source": path.name
                    })
                    continue
                if len(cells) >= 3 and cjk_chars(cells[1]) and has_pinyin(cells[2]):
                    add_word_entry(word_entries, {
                        "grade": grade,
                        "volume": volume,
                        "sourceGrade": grade_label,
                        "lesson": "",
                        "word": cells[1].strip(),
                        "pinyin": clean_pinyin(cells[2]),
                        "source": path.name
                    })
                    continue
                if len(cells) >= 4 and cjk_chars(cells[2]) and has_pinyin(cells[3]):
                    add_word_entry(word_entries, {
                        "grade": grade,
                        "volume": volume,
                        "sourceGrade": grade_label,
                        "lesson": cells[1].strip(),
                        "word": cells[2].strip(),
                        "pinyin": clean_pinyin(cells[3]),
                        "source": path.name
                    })
                    continue
            else:
                grade, volume, grade_label = default_grade, default_volume, default_label
                first = cells[0].strip()
                second = clean_pinyin(cells[1])
                if is_single_char_entry(first):
                    char = first_cjk(first)
                    add_char_entry(char_entries, {
                        "grade": grade,
                        "volume": volume,
                        "sourceGrade": grade_label,
                        "char": char,
                        "pinyin": second,
                        "words": parse_word_segments(cells[2]),
                        "confusables": [c for c in split_confusables(cells[3]) if c != char],
                        "source": path.name
                    })
                    continue
                if cjk_chars(first) and has_pinyin(second):
                    add_word_entry(word_entries, {
                        "grade": grade,
                        "volume": volume,
                        "sourceGrade": grade_label,
                        "lesson": "",
                        "word": first,
                        "pinyin": second,
                        "source": path.name
                    })


def main():
    source_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/Users/han/Desktop/字表库")
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "data" / "word-bank.json"
    if not source_dir.exists():
        raise SystemExit(f"Source directory not found: {source_dir}")

    char_entries = {}
    word_entries = {}
    sources = []
    for path in sorted(source_dir.glob("*.docx")):
        if path.name.startswith(("~$", ".~")):
            continue
        parse_tables(path, char_entries, word_entries, sources)

    chars = sorted(char_entries.values(), key=lambda item: (item["grade"], item["volume"], item["source"], item["char"]))
    words = sorted(word_entries.values(), key=lambda item: (item["grade"], item["volume"], item["source"], item.get("lesson", ""), item["word"]))
    payload = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceDir": str(source_dir),
        "sources": sources,
        "counts": {
            "chars": len(chars),
            "words": len(words)
        },
        "chars": chars,
        "words": words
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload["counts"], ensure_ascii=False))


if __name__ == "__main__":
    main()
