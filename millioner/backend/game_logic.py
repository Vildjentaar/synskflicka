"""
Kim Veri Bilimci Olmak İster? — Oyun mantığı
Oturumlar bellekte tutulur; doğru cevaplar asla istemciye gönderilmez.
"""
import json
import random
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

ROOT_DIR = Path(__file__).resolve().parent.parent
QUESTIONS_FILE = ROOT_DIR / "questions.json"

TOTAL_LEVELS = 12
SAFE_LEVELS = {4, 8}
TIME_GRACE = 4.0  # ağ gecikmesi / animasyon toleransı (sn)

# (değer, etiket)
LADDER = [
    (1_000, "1K"),
    (2_500, "2.5K"),
    (5_000, "5K"),
    (10_000, "10K"),
    (25_000, "25K"),
    (50_000, "50K"),
    (100_000, "100K"),
    (250_000, "250K"),
    (500_000, "500K"),
    (1_000_000, "1M"),
    (10_000_000, "10M"),
    (1_000_000_000, "1 MİLYAR"),
]


def time_limit_for(level: int) -> int:
    if level <= 4:
        return 30
    if level <= 8:
        return 45
    if level <= 11:
        return 60
    return 90


JOKERS = {
    "fifty":    {"name": "%50 Yarı Yarıya",       "unlock": 1},
    "audience": {"name": "Seyirciye Sor",         "unlock": 1},
    "llm":      {"name": "Yapay Zekaya Sor",      "unlock": 5},
    "double":   {"name": "Çift Cevap Hakkı",      "unlock": 9},
}

_lock = threading.Lock()
_questions_cache: Optional[List[dict]] = None


# ---------------- Soru bankası ----------------

GRADE_LABELS = {
    "hazirlik": "Hazırlık",
    "1": "1. Sınıf",
    "2": "2. Sınıf",
    "3": "3. Sınıf",
    "4": "4. Sınıf",
}


def load_questions(force: bool = False) -> List[dict]:
    global _questions_cache
    if _questions_cache is None or force:
        with open(QUESTIONS_FILE, "r", encoding="utf-8") as f:
            _questions_cache = json.load(f)
    return _questions_cache


def save_questions(questions: List[dict]):
    global _questions_cache
    with open(QUESTIONS_FILE, "w", encoding="utf-8") as f:
        json.dump(questions, f, ensure_ascii=False, indent=2)
    _questions_cache = questions


def questions_by_level(level: int, grade: Optional[str] = None) -> List[dict]:
    all_q = load_questions()
    if grade:
        filtered = [
            q for q in all_q
            if int(q.get("level", 1)) == level and (
                q.get("grade") == grade or
                q.get("grade") == "all" or
                (isinstance(q.get("grades"), list) and grade in q.get("grades"))
            )
        ]
        if filtered:
            return filtered
    return [q for q in all_q if int(q.get("level", 1)) == level]


# ---------------- Oturum ----------------

class GameSession:
    def __init__(self, name: str, email: str, wants_membership: bool, grade: str = "hazirlik"):
        self.id = uuid.uuid4().hex
        self.name = name
        self.email = email
        self.grade = grade if grade in GRADE_LABELS else "hazirlik"
        self.wants_membership = wants_membership
        self.level = 1
        self.status = "playing"  # playing | won | lost | timeout | withdrawn
        self.used_ids: set = set()
        self.jokers_used: List[str] = []
        self.started_at = time.time()
        self.finished_at: Optional[float] = None
        self.prize_value = 0
        self.prize_label = "0"
        self.saved = False
        self._load_question()

    # --- soru yönetimi ---
    def _load_question(self, exclude_current: bool = False):
        pool = [q for q in questions_by_level(self.level, self.grade) if q["id"] not in self.used_ids]
        if not pool:  # havuz tükendiyse tekrar izin ver
            pool = questions_by_level(self.level, self.grade)
            if exclude_current and len(pool) > 1:
                pool = [q for q in pool if q["id"] != self.question["id"]]
        if not pool:
            pool = questions_by_level(self.level)
        if not pool:
            raise RuntimeError(f"Seviye {self.level} için soru bulunamadı")
        q = random.choice(pool)
        self.used_ids.add(q["id"])
        self.question = q
        order = list(range(4))
        random.shuffle(order)
        self.order = order  # görüntülenen index -> orijinal index
        self.correct_display = order.index(int(q["answer"]))
        self.removed: List[int] = []
        self.double_active = False
        self.double_wrong: Optional[int] = None
        self.question_started = time.time()
        self.timer_armed = False
        self.time_limit = time_limit_for(self.level)

    # --- yardımcılar ---
    def guaranteed_prize(self):
        safe = [lv for lv in SAFE_LEVELS if lv < self.level]
        if not safe:
            return 0, "0"
        return LADDER[max(safe) - 1]

    def current_prize(self):
        if self.level <= 1:
            return 0, "0"
        return LADDER[self.level - 2]

    def available_jokers(self) -> Dict[str, dict]:
        out = {}
        for key, j in JOKERS.items():
            out[key] = {
                "name": j["name"],
                "unlock": j["unlock"],
                "unlocked": self.level >= j["unlock"],
                "used": key in self.jokers_used,
            }
        return out

    def elapsed_total(self) -> float:
        end = self.finished_at or time.time()
        return round(end - self.started_at, 2)

    def _finish(self, status: str, prize):
        self.status = status
        self.prize_value, self.prize_label = prize
        self.finished_at = time.time()

    def public_state(self) -> dict:
        q = self.question
        remaining = max(0.0, self.time_limit - (time.time() - self.question_started))
        return {
            "session_id": self.id,
            "name": self.name,
            "grade": self.grade,
            "grade_label": GRADE_LABELS.get(self.grade, "Hazırlık"),
            "status": self.status,
            "level": self.level,
            "total_levels": TOTAL_LEVELS,
            "safe_levels": sorted(SAFE_LEVELS),
            "ladder": [{"value": v, "label": l} for v, l in LADDER],
            "question": {
                "id": q["id"],
                "category": q.get("category", "Genel"),
                "text": q["question"],
                "options": [q["options"][i] for i in self.order],
            },
            "removed": self.removed,
            "double_active": self.double_active,
            "double_wrong": self.double_wrong,
            "time_limit": self.time_limit,
            "time_remaining": round(remaining, 2),
            "jokers": self.available_jokers(),
            "current_prize": self.current_prize()[1],
            "guaranteed_prize": self.guaranteed_prize()[1],
        }

    def result_summary(self) -> dict:
        return {
            "status": self.status,
            "grade": self.grade,
            "grade_label": GRADE_LABELS.get(self.grade, "Hazırlık"),
            "correct_count": self.level - 1 if self.status != "won" else TOTAL_LEVELS,
            "prize_value": self.prize_value,
            "prize_label": self.prize_label,
            "total_time": self.elapsed_total(),
            "jokers_used": len(self.jokers_used),
        }

    # --- eylemler ---
    def answer(self, choice: int) -> dict:
        if self.status != "playing":
            raise ValueError("Oyun zaten bitti")

        elapsed = time.time() - self.question_started
        timed_out = choice < 0 or elapsed > self.time_limit + TIME_GRACE
        correct_idx = self.correct_display
        explanation = self.question.get("explanation", "")

        if timed_out:
            self._finish("timeout", self.guaranteed_prize())
            return {"result": "timeout", "correct_index": correct_idx,
                    "explanation": explanation, "summary": self.result_summary()}

        if choice in self.removed:
            raise ValueError("Bu şık elenmiş")

        if choice == correct_idx:
            if self.level >= TOTAL_LEVELS:
                self._finish("won", LADDER[-1])
                return {"result": "won", "correct_index": correct_idx,
                        "explanation": explanation, "summary": self.result_summary()}

            prev_unlocked = {k for k, j in self.available_jokers().items() if j["unlocked"]}
            reached_safe = self.level in SAFE_LEVELS
            won_label = LADDER[self.level - 1][1]
            self.level += 1
            now_unlocked = {k for k, j in self.available_jokers().items() if j["unlocked"]}
            new_jokers = [{"key": k, "name": JOKERS[k]["name"]} for k in JOKERS
                          if k in now_unlocked - prev_unlocked]
            self._load_question()
            return {"result": "correct", "correct_index": correct_idx,
                    "explanation": explanation, "won_label": won_label,
                    "reached_safe": reached_safe, "new_jokers": new_jokers}

        # yanlış cevap
        if self.double_active and self.double_wrong is None:
            self.double_wrong = choice
            self.double_active = False
            if choice not in self.removed:
                self.removed.append(choice)
            return {"result": "retry", "wrong_index": choice}

        self._finish("lost", self.guaranteed_prize())
        return {"result": "wrong", "correct_index": correct_idx, "chosen": choice,
                "explanation": explanation, "summary": self.result_summary()}

    def withdraw(self) -> dict:
        if self.status != "playing":
            raise ValueError("Oyun zaten bitti")
        self._finish("withdrawn", self.current_prize())
        return {"result": "withdrawn", "correct_index": self.correct_display,
                "explanation": self.question.get("explanation", ""),
                "summary": self.result_summary()}

    def use_joker(self, key: str) -> dict:
        if self.status != "playing":
            raise ValueError("Oyun zaten bitti")
        if key not in JOKERS:
            raise ValueError("Geçersiz joker")
        if key in self.jokers_used:
            raise ValueError("Bu joker zaten kullanıldı")
        if self.level < JOKERS[key]["unlock"]:
            raise ValueError(f"Bu joker {JOKERS[key]['unlock']}. soruda açılır")

        self.jokers_used.append(key)
        handler = getattr(self, f"_joker_{key}")
        payload = handler()
        payload["joker"] = key
        payload["state"] = self.public_state()
        return payload

    def _alive_wrong(self) -> List[int]:
        return [i for i in range(4) if i != self.correct_display and i not in self.removed]

    def _joker_fifty(self) -> dict:
        wrong = self._alive_wrong()
        to_remove = random.sample(wrong, k=min(2, max(0, len(wrong) - 1)) if len(wrong) > 1 else 0)
        self.removed.extend(to_remove)
        return {"removed": to_remove}

    def _joker_audience(self) -> dict:
        alive = [i for i in range(4) if i not in self.removed]
        # seviye arttıkça kalabalığın isabeti düşer
        accuracy = max(0.30, 0.82 - 0.045 * (self.level - 1))
        accuracy = min(0.95, accuracy + random.uniform(-0.08, 0.08))
        # zor sorularda nadiren kalabalık yanılır
        crowd_target = self.correct_display
        wrong_alive = [i for i in alive if i != self.correct_display]
        if wrong_alive and self.level >= 9 and random.random() < 0.18:
            crowd_target = random.choice(wrong_alive)

        votes = {i: 0.0 for i in range(4)}
        votes[crowd_target] = accuracy
        rest = 1.0 - accuracy
        others = [i for i in alive if i != crowd_target]
        weights = [random.uniform(0.3, 1.0) for _ in others]
        tw = sum(weights) or 1
        for i, w in zip(others, weights):
            votes[i] = rest * w / tw
        if not others:
            votes[crowd_target] = 1.0
        pct = [round(votes[i] * 100) for i in range(4)]
        diff = 100 - sum(pct)
        pct[crowd_target] += diff
        return {"percentages": pct}

    def _joker_llm(self) -> dict:
        if self.level <= 8:
            p_correct = 0.88
        elif self.level <= 11:
            p_correct = 0.72
        else:
            p_correct = 0.58
        wrong_alive = self._alive_wrong()
        hallucinate = bool(wrong_alive) and random.random() > p_correct
        pick = random.choice(wrong_alive) if hallucinate else self.correct_display
        confidence = random.randint(71, 97) if not hallucinate else random.randint(78, 99)
        letter = "ABCD"[pick]
        option_text = self.question["options"][self.order[pick]]
        templates = [
            f"Verilerimi ve genel kültür bilgilerimi taradım. En olası cevap {letter}: \"{option_text}\".",
            f"Bu soruyu analiz ettim. Mantıksal çıkarımıma göre doğru cevap {letter} şıkkı: \"{option_text}\".",
            f"Yapay zeka analizime göre en tutarlı ve doğru seçenek {letter}: \"{option_text}\" görünüyor.",
        ]
        return {
            "pick": pick,
            "confidence": confidence,
            "message": random.choice(templates),
            "disclaimer": "⚠️ Yapay zeka modelleri bazen yanıltıcı veya hatalı cevaplar verebilir!",
        }

    def _joker_swap(self) -> dict:
        old = self.question["question"]
        self._load_question(exclude_current=True)
        return {"swapped_from": old}

    def _joker_double(self) -> dict:
        self.double_active = True
        return {"double_active": True}


class SessionStore:
    def __init__(self):
        self.sessions: Dict[str, GameSession] = {}

    def create(self, name: str, email: str, wants_membership: bool, grade: str = "hazirlik") -> GameSession:
        with _lock:
            self._cleanup()
            s = GameSession(name, email, wants_membership, grade=grade)
            self.sessions[s.id] = s
            return s

    def get(self, sid: str) -> Optional[GameSession]:
        return self.sessions.get(sid)

    def _cleanup(self):
        cutoff = time.time() - 3 * 3600
        for sid in [k for k, v in self.sessions.items() if v.started_at < cutoff]:
            del self.sessions[sid]


store = SessionStore()
