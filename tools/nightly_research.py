#!/usr/bin/env python3
"""
tools/nightly_research.py — ночное исследование строёв гитары.
Берёт pending-группы из research/backlog.json, исследует каждую через
Claude Code, коммитит отдельно. Жёсткий предел: 90 минут.

Флаги:
  --one              обработать одну группу и выйти
  --batch N          обработать не более N групп (по умолчанию MAX_GROUPS=6)
  --artist NAME      исследовать конкретного артиста (по имени)
  --dry-run          промпт в stdout, Claude не вызывать
"""

import json
import subprocess
import sys
import time
import os
import re
import threading
import atexit
from datetime import date
from pathlib import Path

REPO    = Path(__file__).parent.parent
BACKLOG = REPO / "research" / "backlog.json"
PENDING = REPO / "verified" / "pending.json"
REVIEW  = REPO / "research" / "REVIEW.md"
LOCKFILE = Path("/tmp/tuning-research.lock")

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


# ── lockfile ─────────────────────────────────────────────────────────

def acquire_lock():
    if LOCKFILE.exists():
        pid_str = LOCKFILE.read_text().strip()
        try:
            pid = int(pid_str)
            os.kill(pid, 0)           # process exists?
            log(f"Уже запущен (PID {pid}). Выхожу.")
            sys.exit(0)
        except (ProcessLookupError, ValueError):
            log(f"Стейл-локфайл (PID {pid_str}), удаляю.")
            LOCKFILE.unlink()
    LOCKFILE.write_text(str(os.getpid()))
    atexit.register(release_lock)


def release_lock():
    if LOCKFILE.exists():
        try:
            LOCKFILE.unlink()
        except Exception:
            pass


# ── helpers ──────────────────────────────────────────────────────────

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


# ── prompt ───────────────────────────────────────────────────────────

def build_prompt(artist: str, region: str) -> str:
    lang = LANG_HINTS.get(region, "поиск по-английски")
    existing = ", ".join(already_researched())
    return f"""Ты — исследователь строёв гитары. Задача: найти конкретные строи для группы «{artist}» ({region}).

ПРАВИЛА:
1. ОБЯЗАТЕЛЬНО проверь минимум 3 независимых направления поиска:
   - Официальный сайт/интервью/плейтру музыканта
   - guitartabs.cc или аналог (краудсорс-табы)
   - ultimate-guitar.com, songsterr.com, или gtdb.org
   Если хотя бы одно направление недоступно — попробуй альтернативу.
2. Сначала ищи НА ЯЗЫКЕ СТРАНЫ ({lang}), потом по-английски.
3. Приоритет источников: официальный сайт > нотные издания > заголовки табов.
4. КАЖДЫЙ URL открой и убедись, что строй виден. Ссылки за логином не добавляй.
5. Нет рабочей ссылки — нет записи.
6. Строй конкретной песни. Общий строй группы — только medium + пометка в note.
7. Пропускай E standard (E2 A2 D3 G3 B3 E4).
8. confidence: high = два НЕЗАВИСИМЫХ источника по ЭТОЙ ЖЕ песне, хотя бы один первичный.
   Таб другой песни НЕ считается источником для текущей песни. medium = один источник.
9. Нотация: от низкой струны к высокой. Бемоли в диезы (Ab→G#, Bb→A#). Верхняя струна C4–F4.
10. Не больше 1 запроса в секунду к одному сайту.

СТАТУСЫ:
- "done"      — нашёл альтернативные строи
- "empty"     — ПОДТВЕРЖДЕНО, что группа играет только E standard (нашёл, смотрел, убедился)
- "not-found" — источники недоступны или нет данных ни в одном из 3+ направлений
- "standard"  — ЯВНО подтверждено в источнике, что группа играет E standard

ФОРМАТ ВЫВОДА — только JSON-объект:
{{
  "entries": [
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
  ],
  "status": "done|empty|not-found|standard",
  "search_log": "Кратко: где искал, что вернулось (1-3 предложения)"
}}

Если ничего не найдено, entries=[] и status="not-found" или "empty" или "standard" по ситуации.

Уже исследованные группы (не дублируй): {existing}

Работай методично. Открывай каждый URL реально. Сообщай прогресс на каждый поиск."""


# ── Claude ───────────────────────────────────────────────────────────

def call_claude(prompt: str, artist: str) -> str:
    proc = subprocess.Popen(
        ["claude", "--print", "--dangerously-skip-permissions"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout_chunks: list = []
    done_event = threading.Event()

    def reader():
        for line in proc.stdout:
            stdout_chunks.append(line)
        done_event.set()

    src_labels = [
        "официальный сайт / интервью",
        "guitartabs.cc",
        "ultimate-guitar.com / songsterr.com",
        "gtdb.org",
    ]

    def keepalive():
        i = 0
        while not done_event.wait(timeout=15):
            log(f"  [{artist}] жду ответ Claude… ({src_labels[i % len(src_labels)]})")
            i += 1

    t_reader  = threading.Thread(target=reader,    daemon=True)
    t_alive   = threading.Thread(target=keepalive, daemon=True)
    t_reader.start()
    t_alive.start()

    proc.stdin.write(prompt)
    proc.stdin.close()
    proc.wait(timeout=600)
    done_event.set()
    t_reader.join(timeout=5)

    stderr_out = proc.stderr.read()
    if stderr_out and proc.returncode != 0:
        log(f"  stderr: {stderr_out[:200]}")

    return "".join(stdout_chunks)


# ── parsing ───────────────────────────────────────────────────────────

def extract_result(text: str) -> tuple:
    """Вернуть (entries_list, status_str, search_log_str)."""
    # Попробуем JSON-объект первым
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == "{":
            if start is None:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    obj = json.loads(text[start:i + 1])
                    entries    = obj.get("entries", [])
                    status     = obj.get("status", "not-found")
                    search_log = obj.get("search_log", "")
                    return entries, status, search_log
                except json.JSONDecodeError:
                    start = None
                    depth = 0

    # Фолбек: попробуем JSON-массив
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
                    entries = json.loads(text[start:i + 1])
                    status  = "done" if entries else "not-found"
                    return entries, status, ""
                except json.JSONDecodeError:
                    start = None
                    depth = 0

    return [], "not-found", ""


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


# ── REVIEW.md ────────────────────────────────────────────────────────

def generate_review(pending, backlog):
    entries    = pending["entries"]
    high       = [e for e in entries if e.get("confidence") == "high"]
    medium     = [e for e in entries if e.get("confidence") == "medium"]
    done_count = sum(1 for g in backlog if g["status"] == "done")
    empty_count     = sum(1 for g in backlog if g["status"] == "empty")
    not_found_count = sum(1 for g in backlog if g["status"] == "not-found")
    standard_count  = sum(1 for g in backlog if g["status"] == "standard")
    pending_count   = sum(1 for g in backlog if g["status"] == "pending")

    primary_groups = []
    for e in entries:
        srcs = e.get("sources", [])
        is_primary = any(
            "guitartabs" not in s
            and "ultimate-guitar" not in s
            and "songsterr" not in s
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
        f"- Групп обработано: {done_count + empty_count + not_found_count + standard_count} "
        f"(done={done_count}, empty={empty_count}, not-found={not_found_count}, "
        f"standard={standard_count}, pending={pending_count})",
        f"- Записей всего: {len(entries)} (high={len(high)}, medium={len(medium)})",
        f"- Первичные источники: {', '.join(primary_groups) if primary_groups else 'нет'}",
    ]

    # Пустые/not-found группы с логом
    special = [g for g in backlog if g["status"] in ("empty", "not-found", "standard")]
    if special:
        lines += ["", "## Пустые / не найденные"]
        for g in special:
            trail = g.get("search_log", "")
            lines.append(f"- **{g['artist']}** [{g['status']}]: {trail or 'след поиска не сохранён'}")

    lines += [
        "",
        "## Записи",
        "",
        "| Группа | Песня | Строй | Уровень | Источник | Суть |",
        "|--------|-------|-------|---------|----------|------|",
    ]

    for e in sorted(
        entries,
        key=lambda x: (0 if x.get("confidence") == "high" else 1, x["artist"]),
    ):
        conflict = " ⚠️" if e.get("conflict") else ""
        lines.append(
            f"| {e['artist']} | {e['song']}{conflict} | {fmt_strings(e)} "
            f"| {e.get('confidence','?')} | {fmt_source(e)} | {fmt_note(e)} |"
        )

    REVIEW.write_text("\n".join(lines) + "\n")
    return len(entries)


# ── main ─────────────────────────────────────────────────────────────

def _main(args):
    os.chdir(REPO)
    git("checkout", "tuning-research")

    log("=== Ночной прогон строёв ===")

    # разбор аргументов
    max_groups = int(os.environ.get("MAX_GROUPS", 6))
    one_only   = "--one" in args
    dry_run    = "--dry-run" in args

    if "--batch" in args:
        idx = args.index("--batch")
        try:
            max_groups = int(args[idx + 1])
        except (IndexError, ValueError):
            pass

    target_artist = None
    if "--artist" in args:
        idx = args.index("--artist")
        if idx + 1 < len(args):
            target_artist = args[idx + 1]

    if one_only:
        max_groups = 1

    backlog = load_backlog()

    if target_artist:
        pending_groups = [g for g in backlog if g["artist"] == target_artist]
        if not pending_groups:
            log(f"Артист «{target_artist}» не найден в backlog.")
            return
        # сбросить в pending для повтора
        for g in pending_groups:
            g["status"] = "pending"
    else:
        pending_groups = [g for g in backlog if g["status"] == "pending"][:max_groups]

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

        if dry_run:
            print("\n=== PROMPT ===\n")
            print(prompt)
            print("=== END PROMPT ===\n")
            continue

        try:
            raw = call_claude(prompt, artist)
        except subprocess.TimeoutExpired:
            log(f"Таймаут Claude для {artist}, пропускаем.")
            g["status"] = "not-found"
            g["search_log"] = "Таймаут"
            save_backlog(backlog)
            continue
        except Exception as ex:
            log(f"Ошибка Claude для {artist}: {ex}")
            g["status"] = "not-found"
            g["search_log"] = str(ex)[:120]
            save_backlog(backlog)
            continue

        log(f"Claude ответил ({len(raw)} символов)")

        new_entries, status, search_log = extract_result(raw)

        if not new_entries and status not in ("empty", "standard"):
            status = "not-found"

        pending_data = load_pending()
        added = merge_entries(pending_data, new_entries, artist)

        if added > 0:
            pending_data["batch"] = pending_data.get("batch", 1) + 1
            pending_data["date"]  = str(date.today())
            save_pending(pending_data)

        # Обновить статус группы
        if added > 0:
            g["status"] = "done"
        else:
            g["status"] = status  # "empty" / "not-found" / "standard"
        g["entries"]    = added
        g["search_log"] = search_log
        save_backlog(backlog)

        log(f"{artist}: добавлено {added}, статус={g['status']}, лог={search_log[:80]}")

        git("add", "verified/pending.json", "research/backlog.json")
        diff = subprocess.run(
            ["git", "-C", str(REPO), "diff", "--cached", "--quiet"],
            capture_output=True,
        )
        if diff.returncode != 0:
            git("commit", "-m", f"research: {artist}, {added} entries [{g['status']}]")
            git("push", "origin", "tuning-research")
            log("Закоммичено и запушено.")
        else:
            log(f"Нечего коммитить для {artist}.")

        processed += 1

    if dry_run:
        return

    # Обновить REVIEW.md
    log("Генерирую research/REVIEW.md…")
    pending_data = load_pending()
    backlog      = load_backlog()
    n = generate_review(pending_data, backlog)
    log(f"REVIEW.md: {n} записей")

    git("add", "research/REVIEW.md")
    diff = subprocess.run(
        ["git", "-C", str(REPO), "diff", "--cached", "--quiet"],
        capture_output=True,
    )
    if diff.returncode != 0:
        git("commit", "-m", "research: update REVIEW.md")
        git("push", "origin", "tuning-research")

    log(f"Готово. Обработано групп: {processed}")


def main():
    acquire_lock()
    try:
        _main(sys.argv[1:])
    finally:
        release_lock()


if __name__ == "__main__":
    main()
