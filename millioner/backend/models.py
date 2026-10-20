import sqlite3
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel, Field

DB_PATH = Path(__file__).resolve().parent / "milyoner.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT UNIQUE,
            name TEXT NOT NULL,
            email TEXT,
            grade TEXT DEFAULT 'hazirlik',
            wants_membership INTEGER DEFAULT 0,
            correct_count INTEGER NOT NULL,
            prize_value INTEGER NOT NULL,
            prize_label TEXT NOT NULL,
            status TEXT NOT NULL,
            total_time REAL NOT NULL,
            jokers_used INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Migration if table exists without grade column
    cursor.execute("PRAGMA table_info(scores)")
    columns = [row["name"] for row in cursor.fetchall()]
    if "grade" not in columns:
        try:
            cursor.execute("ALTER TABLE scores ADD COLUMN grade TEXT DEFAULT 'hazirlik'")
        except sqlite3.OperationalError:
            pass

    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_rank ON scores (correct_count DESC, total_time ASC)"
    )
    conn.commit()
    conn.close()


# ---------- Request models ----------

class StartRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=24)
    email: Optional[str] = Field(default="", max_length=120)
    grade: str = Field(default="hazirlik", max_length=20)
    wants_membership: bool = False


class AnswerRequest(BaseModel):
    choice: int = Field(..., ge=-1, le=3, description="-1 = süre doldu")


class QuestionIn(BaseModel):
    level: int = Field(..., ge=1, le=12)
    grade: str = Field(default="all", max_length=20)
    category: str = Field(default="Genel", max_length=40)
    question: str = Field(..., min_length=5, max_length=300)
    options: List[str] = Field(..., min_length=4, max_length=4)
    answer: int = Field(..., ge=0, le=3)
    explanation: str = Field(default="", max_length=300)


class SettingsIn(BaseModel):
    join_url: str = Field(default="", max_length=300)
