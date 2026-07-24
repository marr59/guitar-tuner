#!/usr/bin/env python3
"""
tools/nightly_research.py — ночное исследование строёв гитары.
Берёт первые MAX_GROUPS pending-групп из research/backlog.json,
исследует каждую через Claude Code, коммитит отдельно.
Жёсткий предел: 90 минут.
"""

import json
import subprocess
import sys
import time
import os
import re
from datetime import date
from pathlib import Path

REPO = Path(__file__).parent.parent
BACKLOG = REPO / "research" / "backlog.json"
PENDING = REPO / "verified" / "pending.json"
REVIEW = REPO / "research" / "REVIEW.md"
MAX_GROUPS = int(os.environ.get("MAX_GROUPS", 6))
DEADLINE = time.time() + 90 * 60

LANG_HINTS = {
    "Финляндия": "viritys, viritetty — поиск по-фински",
    "Швеция":    "stämning, stämmer — поиск по-шведски",
    "Норвегия":  "stemming, stemmer — поиск по-норвежски",
    "Дания":     "stemning — поиск по-датски",
    "Германия":  "Stimmung, gestimmt — поиск по-немецки",
    "Польша":    "strojenie, strojony — поиск по-польски",
    "Италия":    "accordatura — поиск по-итальянски",
    "Бразилия":  "afinação — поиск по-португальски",
    "Аргентина": "afinación — поиск по-испански",
    "Мексика":   "afinación — поиск по-испански",
    "Чили":      "afinación — поиск по-испански",
    "Япония":    "チューニング — поиск по-японски",
    "Корея":     "튜닝 — поиск по-корейски",
}


def log(msg: str):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def load_backlog():
    return json.loads(BACKLOG.read_text())


def save_backlog(bl):
    BACKLOG.write_text(json.dumps(bl, ensure_ascii=False, indent=2))


def load_pending():
    return json.loads(PENDING.read_text())


def save_pending(p):
    PENDING.write_text(json.dumps(p, ensure_ascii=False, indent=2))


def git(*args):
    subprocess.run(["git", "-C", str(REPO)] + list(args), check=True)


def already_researched():
    p = load_pending()
    return sorted({e["artist"] for e in p["entries"]})


def build_prompt(artist: str, region: str) -> str:
    lang = LANG_HINTS.get(region, "поиск по-английски")
    existing = ", ".join(already_researched())
    return f"""Ты — исследователь строёв гитары. Твоя задача: найти конкретные строи для группы «{artist}» ({region}).

ПРАВИЛА:
1. Сначала ищи НА ЯЗЫКЕ СТРАНЫ ({lang}), потом по-английски.
2. Приоритет: официальный сайт группы (FAQ, интервью, плейтру музыканта, ноты) > заголовки табов.
3. КАЖДЫЙ URL открой и убедись, что строй виден. Ссылки за логином не добавляй.
4. Нет рабочей ссылки — нет записи.
5. Строй конкретной песни. Общий строй группы — только medium + пометка в note.
6. Пропускай E standard (E2 A2 D3 G3 B3 E4).
7. confidence: high = два НЕЗАВИСИМЫХ источника по ЭТОЙ ЖЕ песне, хотя бы один первичный. Таб другой песни НЕ считается источником. medium = один источник.
8. Нотация: от низкой струны к высокой. Бемоли в диезы (Ab→G#, Bb→A#). Верхняя струна обычно C4–F4.
9. Не больше 1 запроса в секунду к одному сайту.

ФОРМАТ ВЫВОДА — только JSON-массив новых записей (или пустой массив []):
[
  {{
    "artist": "{artist}",
    "song": "...",
    "album": "...",
    "year": 2000,
    "confidence": "medium",
    "capo": 0,
    "conflict": false,
    "variants": [{{"label": "Studio", "strings": ["X2","X2","X3","X3","X3","X4"]}}],
    "note": "...",
    "sources": ["https://..."],
    "_verified_by": "Claude — краткое описание что увидел в источнике"
  }}
]

Уже исследованные группы (не дублируй): {existing}

Работай методично. Сообщай прогресс на каждый поиск. Если ничего не найдено — верни [].
"""


def call_claude(prompt: str) -> str:
    result = subprocess.run(
        ["claude", "--print"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return result.stdout


def extract_json_array(text: str):
    """Найти JSON-массив в произвольном тексте."""
    # Ищем от первой [ до парной ]
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == "[":
            if start is None:
                start = i
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    start = None
                    depth = 0
    return []


def merge_entries(pending, new_entries, artist):
    existing_keys = {(e["artist"], e["song"]) for e in pending["entries"]}
    added = 0
    for e in new_entries:
        if e.get("artist") != artist:
            continue
        key = (e["artist"], e.get("song", ""))
        if key in existing_keys:
            continue
        pending["entries"].append(e)
        existing_keys.add(key)
        added += 1
    return added


def generate_review(pending, backlog):
    entries = pending["entries"]
    high = [e for e in entries if e.get("confidence") == "high"]
    medium = [e for e in entries if e.get("confidence") == "medium"]

    done_count = sum(1 for g in backlog if g["status"] == "done")
    empty_count = sum(1 for g in backlog if g["status"] == "empty")
    pending_count = sum(1 for g in backlog if g["status"] == "pending")

    primary_groups = []
    for e in entries:
        srcs = e.get("sources", [])
        is_primary = any(
            "guitartabs" not in s and "ultimate-guitar" not in s and "songsterr" not in s
            for s in srcs
        )
        if is_primary and e["artist"] not in primary_groups:
            primary_groups.append(e["artist"])

    def fmt_strings(e):
        for v in e.get("variants", []):
            return " ".join(v.get("strings", []))
        return "?"

    def fmt_source(e):
        from urllib.parse import urlparse
        srcs = e.get("sources", [])
        if not srcs:
            return "—"
        return urlparse(srcs[0]).netloc.replace("www.", "")

    def fmt_note(e):
        n = e.get("note", "")
        return (n[:60] + "…") if len(n) > 60 else n

    lines = [
        "# Tuning Research — REVIEW",
        "",
        f"Обновлено: {date.today()}",
        "",
        "## Сводка",
        f"- Групп обработано: {done_count + empty_count} (done={done_count}, empty={empty_count}, pending={pending_count})",
        f"- Записей всего: {len(entries)} (high={len(high)}, medium={len(medium)})",
        f"- Первичные источники: {', '.join(primary_groups) if primary_groups else 'нет'}",
        "",
        "## Записи",
        "",
        "| Группа | Песня | Строй | Уровень | Источник | Суть |",
        "|--------|-------|-------|---------|----------|------|",
    ]

    for e in sorted(entries, key=lambda x: (0 if x.get("confidence") == "high" else 1, x["artist"])):
        lines.append(
            f"| {e['artist']} | {e['song']} | {fmt_strings(e)} | {e.get('confidence','?')} | {fmt_source(e)} | {fmt_note(e)} |"
        )

    REVIEW.write_text("\n".join(lines) + "\n")
    return len(entries)


def main():
    os.chdir(REPO)
    git("checkout", "tuning-research")

    log("=== Ночной прогон строёв ===")

    backlog = load_backlog()
    pending_groups = [g for g in backlog if g["status"] == "pending"][:MAX_GROUPS]

    if not pending_groups:
        log("Очередь пуста. Нечего делать.")
        return

    processed = 0

    for g in pending_groups:
        if time.time() >= DEADLINE:
            log("Дедлайн 90 мин. Останавливаемся.")
            break

        artist = g["artist"]
        region = g["region"]
        log(f"--- Исследую: {artist} ({region}) ---")

        prompt = build_prompt(artist, region)

        try:
            raw = call_claude(prompt)
        except subprocess.TimeoutExpired:
            log(f"Таймаут Claude для {artist}, пропускаем.")
            g["status"] = "empty"
            save_backlog(backlog)
            continue
        except Exception as ex:
            log(f"Ошибка Claude для {artist}: {ex}, пропускаем.")
            g["status"] = "empty"
            save_backlog(backlog)
            continue

        log(f"Claude ответил ({len(raw)} символов)")

        new_entries = extract_json_array(raw)
        pending = load_pending()
        added = merge_entries(pending, new_entries, artist)

        if added > 0:
            pending["batch"] = pending.get("batch", 1) + 1
            pending["date"] = str(date.today())
            save_pending(pending)

        g["status"] = "empty" if added == 0 else "done"
        g["entries"] = added
        save_backlog(backlog)

        log(f"{artist}: добавлено {added} записей")

        git("add", "verified/pending.json", "research/backlog.json")
        result = subprocess.run(
            ["git", "-C", str(REPO), "diff", "--cached", "--quiet"],
            capture_output=True,
        )
        if result.returncode != 0:
            git("commit", "-m", f"research: {artist}, {added} entries")
            git("push", "origin", "tuning-research")
            log("Закоммичено и запушено.")
        else:
            log(f"Нечего коммитить для {artist}.")

        processed += 1

    # Обновить REVIEW.md
    log("Генерирую research/REVIEW.md...")
    pending = load_pending()
    backlog = load_backlog()
    n = generate_review(pending, backlog)
    log(f"REVIEW.md: {n} строк таблицы")

    git("add", "research/REVIEW.md")
    result = subprocess.run(
        ["git", "-C", str(REPO), "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if result.returncode != 0:
        git("commit", "-m", "research: update REVIEW.md")
        git("push", "origin", "tuning-research")

    log(f"Готово. Обработано групп: {processed}")


if __name__ == "__main__":
    main()
