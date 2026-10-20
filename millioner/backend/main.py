import csv
import html
import io
import json
import re
import sys
import uuid
from pathlib import Path
from typing import Optional

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from models import init_db, get_db, StartRequest, AnswerRequest, QuestionIn, SettingsIn
from game_logic import store, load_questions, save_questions, LADDER, JOKERS, SAFE_LEVELS, TOTAL_LEVELS, GRADE_LABELS

init_db()

app = FastAPI(
    title="Akdeniz VBT — Kim Veri Bilimci Olmak İster? API",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
SETTINGS_FILE = ROOT_DIR / "settings.json"
ADMIN_KEY = "akdeniz2026"

PROFANITY_PATTERNS = [
    r"sik", r"yarrak", r"amk", r"aq", r"oç", r"piç", r"kahpe",
    r"fuck", r"bitch", r"shit", r"asshole", r"dick", r"cunt",
]


def sanitize_name(name: str) -> str:
    cleaned = html.escape(name.strip())
    lower = cleaned.lower()
    for pat in PROFANITY_PATTERNS:
        if re.search(r"\b" + pat + r"\b", lower):
            return "Yarışmacı_" + str(abs(hash(name)) % 9000 + 1000)
    return cleaned[:24]


def check_admin(key: str):
    if key != ADMIN_KEY:
        raise HTTPException(status_code=403, detail="Geçersiz yetki anahtarı")


def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"join_url": ""}


def get_session_or_404(sid: str):
    s = store.get(sid)
    if not s:
        raise HTTPException(status_code=404, detail="Oturum bulunamadı")
    return s


def persist_score(s):
    if s.saved or s.status == "playing":
        return None
    summary = s.result_summary()
    conn = get_db()
    cur = conn.cursor()
    grade = getattr(s, "grade", "hazirlik")
    cur.execute("""
        INSERT OR IGNORE INTO scores
        (session_id, name, email, grade, wants_membership, correct_count, prize_value,
         prize_label, status, total_time, jokers_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (s.id, s.name, s.email, grade, int(s.wants_membership), summary["correct_count"],
          summary["prize_value"], summary["prize_label"], s.status,
          summary["total_time"], summary["jokers_used"]))
    conn.commit()
    cur.execute("""
        SELECT COUNT(*) FROM scores
        WHERE correct_count > ? OR (correct_count = ? AND total_time < ?)
    """, (summary["correct_count"], summary["correct_count"], summary["total_time"]))
    rank = cur.fetchone()[0] + 1
    conn.close()
    s.saved = True
    return rank


# ---------------- Oyun API ----------------

@app.get("/api/config")
def get_config():
    return {
        "total_levels": TOTAL_LEVELS,
        "safe_levels": sorted(SAFE_LEVELS),
        "ladder": [{"value": v, "label": l} for v, l in LADDER],
        "jokers": JOKERS,
        "question_count": len(load_questions()),
        "join_url": load_settings().get("join_url", ""),
        "grade_labels": GRADE_LABELS,
    }


@app.post("/api/game/start")
def start_game(req: StartRequest):
    name = sanitize_name(req.name)
    if len(name) < 2:
        name = "Gizli Yarışmacı"
    email = (req.email or "").strip().lower()[:120]
    grade = (req.grade or "hazirlik").strip().lower()
    if grade not in GRADE_LABELS:
        grade = "hazirlik"
    try:
        s = store.create(name, email, req.wants_membership, grade=grade)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return s.public_state()


@app.get("/api/game/{sid}")
def get_state(sid: str):
    return get_session_or_404(sid).public_state()


@app.post("/api/game/{sid}/answer")
def answer(sid: str, req: AnswerRequest):
    s = get_session_or_404(sid)
    try:
        result = s.answer(req.choice)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if s.status != "playing":
        result["rank"] = persist_score(s)
    else:
        result["state"] = s.public_state() if result["result"] == "retry" else None
    return result


@app.post("/api/game/{sid}/next")
def next_question(sid: str):
    """Doğru cevaptan sonra yeni sorunun zamanlayıcısını başlatır."""
    import time
    s = get_session_or_404(sid)
    if s.status == "playing" and not getattr(s, "timer_armed", False):
        s.question_started = time.time()
        s.timer_armed = True
    return s.public_state()


@app.post("/api/game/{sid}/joker/{key}")
def use_joker(sid: str, key: str):
    s = get_session_or_404(sid)
    try:
        return s.use_joker(key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/game/{sid}/withdraw")
def withdraw(sid: str):
    s = get_session_or_404(sid)
    try:
        result = s.withdraw()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    result["rank"] = persist_score(s)
    return result


# ---------------- Liderlik ----------------

@app.get("/api/leaderboard")
def leaderboard(limit: int = Query(50, ge=1, le=200), grade: Optional[str] = Query(None)):
    conn = get_db()
    cur = conn.cursor()
    if grade and grade in GRADE_LABELS:
        cur.execute("""
            SELECT id, name, grade, correct_count, prize_label, prize_value, status, total_time,
                   jokers_used, created_at
            FROM scores
            WHERE grade = ?
            ORDER BY correct_count DESC, total_time ASC
            LIMIT ?
        """, (grade, limit))
    else:
        cur.execute("""
            SELECT id, name, grade, correct_count, prize_label, prize_value, status, total_time,
                   jokers_used, created_at
            FROM scores
            ORDER BY correct_count DESC, total_time ASC
            LIMIT ?
        """, (limit,))
    rows = cur.fetchall()
    cur.execute("""
        SELECT name, grade, total_time, created_at FROM scores
        WHERE status = 'won' ORDER BY total_time ASC
    """)
    winners = []
    for r in cur.fetchall():
        w = dict(r)
        w["grade_label"] = GRADE_LABELS.get(w.get("grade"), "Hazırlık")
        winners.append(w)
    conn.close()
    scores = []
    for idx, r in enumerate(rows, start=1):
        d = dict(r)
        d["rank"] = idx
        d["grade_label"] = GRADE_LABELS.get(d.get("grade"), "Hazırlık")
        scores.append(d)
    return {"scores": scores, "millionaires": winners}


@app.get("/api/stats")
def stats():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT COUNT(*), SUM(CASE WHEN status='won' THEN 1 ELSE 0 END),
               AVG(correct_count), SUM(wants_membership)
        FROM scores
    """)
    total, winners, avg_level, members = cur.fetchone()
    conn.close()
    return {
        "total_games": total or 0,
        "millionaires": winners or 0,
        "avg_correct": round(avg_level or 0, 1),
        "membership_requests": members or 0,
    }


# ---------------- QR (topluluğa katıl) ----------------

@app.get("/api/qr")
def join_qr():
    url = load_settings().get("join_url", "")
    if not url:
        raise HTTPException(status_code=404, detail="Katılım linki ayarlanmamış")
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        raise HTTPException(status_code=501, detail="qrcode kütüphanesi kurulu değil")
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathFillImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


# ---------------- Admin ----------------

@app.get("/api/admin/questions")
def admin_questions(secret_key: str = Query(...)):
    check_admin(secret_key)
    return {"questions": load_questions()}


@app.post("/api/admin/questions")
def admin_add_question(q: QuestionIn, secret_key: str = Query(...)):
    check_admin(secret_key)
    questions = list(load_questions())
    item = q.model_dump()
    item["id"] = "q_" + uuid.uuid4().hex[:8]
    questions.append(item)
    save_questions(questions)
    return {"success": True, "question": item}


@app.delete("/api/admin/questions/{qid}")
def admin_delete_question(qid: str, secret_key: str = Query(...)):
    check_admin(secret_key)
    questions = list(load_questions())
    target = next((q for q in questions if q["id"] == qid), None)
    if not target:
        raise HTTPException(status_code=404, detail="Soru bulunamadı")
    same_level = [q for q in questions if q["level"] == target["level"]]
    if len(same_level) <= 2:
        raise HTTPException(status_code=400, detail="Her seviyede en az 2 soru kalmalı")
    save_questions([q for q in questions if q["id"] != qid])
    return {"success": True}


@app.get("/api/admin/settings")
def admin_get_settings(secret_key: str = Query(...)):
    check_admin(secret_key)
    return load_settings()


@app.post("/api/admin/settings")
def admin_save_settings(body: SettingsIn, secret_key: str = Query(...)):
    check_admin(secret_key)
    data = load_settings()
    data["join_url"] = body.join_url.strip()
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return {"success": True, **data}


@app.post("/api/admin/reset")
def admin_reset(secret_key: str = Query(...)):
    check_admin(secret_key)
    conn = get_db()
    conn.execute("DELETE FROM scores")
    conn.commit()
    conn.close()
    return {"success": True, "message": "Skorlar sıfırlandı"}


@app.get("/api/admin/export")
def admin_export(secret_key: str = Query(...)):
    check_admin(secret_key)
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT name, email, grade, wants_membership, correct_count, prize_label, status,
               total_time, jokers_used, created_at
        FROM scores ORDER BY correct_count DESC, total_time ASC
    """)
    rows = cur.fetchall()
    conn.close()
    buf = io.StringIO()
    buf.write("\ufeff")  # Excel için UTF-8 BOM
    w = csv.writer(buf, delimiter=";")
    w.writerow(["İsim", "Sınıf", "E-posta", "Üyelik İsteği", "Doğru Sayısı", "Ödül", "Durum",
                "Süre (sn)", "Joker", "Tarih"])
    for r in rows:
        g_label = GRADE_LABELS.get(r["grade"], r["grade"] or "Hazırlık")
        w.writerow([r["name"], g_label, r["email"] or "", "Evet" if r["wants_membership"] else "Hayır",
                    r["correct_count"], r["prize_label"], r["status"], r["total_time"],
                    r["jokers_used"], r["created_at"]])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=milyoner_katilimcilar.csv"},
    )


# ---------------- Statik dosyalar ----------------

for sub in ("css", "js", "assets"):
    if (FRONTEND_DIR / sub).exists():
        app.mount(f"/{sub}", StaticFiles(directory=str(FRONTEND_DIR / sub)), name=sub)


def _page(name: str):
    return lambda: FileResponse(FRONTEND_DIR / name)


for route, page in [("", "index.html"), ("index", "index.html"), ("game", "game.html"),
                    ("leaderboard", "leaderboard.html"), ("admin", "admin.html")]:
    app.add_api_route(f"/{route}", _page(page), methods=["GET"], include_in_schema=False)
    if route:
        app.add_api_route(f"/{route}.html", _page(page), methods=["GET"], include_in_schema=False)


if __name__ == "__main__":
    print("\n[SERVER] Akdeniz VBT - Kim Veri Bilimci Olmak Ister? -> http://0.0.0.0:8001 ...")
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False)
