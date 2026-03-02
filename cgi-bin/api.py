#!/usr/bin/env python3
"""
TwiLight Smart Home — Backend API
CGI-bin script with SQLite, session auth, device management.
"""

import json
import os
import re
import secrets
import sqlite3
import sys
import hashlib
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Optional bcrypt — fall back to PBKDF2-HMAC-SHA256 if unavailable
# ---------------------------------------------------------------------------
try:
    import bcrypt
    _USE_BCRYPT = True
except ImportError:
    _USE_BCRYPT = False

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DB_PATH = "data.db"
SESSION_TTL_HOURS = 24
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15
MAX_BODY_BYTES = 1_048_576  # 1 MB
PASSWORD_MIN_LEN = 8
BCRYPT_ROUNDS = 12
PBKDF2_ITERATIONS = 100_000

EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init_db(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS login_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            success INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            room TEXT NOT NULL,
            type TEXT NOT NULL,
            is_on INTEGER DEFAULT 0,
            brightness INTEGER DEFAULT 100,
            speed TEXT DEFAULT 'Off',
            temp INTEGER DEFAULT 72,
            mode TEXT DEFAULT 'Auto',
            power_draw REAL DEFAULT 0,
            locked INTEGER DEFAULT 1,
            favorite INTEGER DEFAULT 0,
            color_temp INTEGER DEFAULT 50,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    """)
    db.commit()

# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    if _USE_BCRYPT:
        salt = bcrypt.gensalt(rounds=BCRYPT_ROUNDS)
        return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")
    # PBKDF2 fallback: "salt_hex$hash_hex"
    salt = os.urandom(32)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return salt.hex() + "$" + dk.hex()


def verify_password(password: str, stored_hash: str) -> bool:
    if _USE_BCRYPT and not "$" in stored_hash[:3]:
        # bcrypt hashes start with $2b$, $2a$, $2y$
        if stored_hash.startswith("$2"):
            try:
                return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
            except Exception:
                return False
    # PBKDF2 fallback
    if "$" in stored_hash:
        parts = stored_hash.split("$", 1)
        if len(parts) == 2:
            try:
                salt = bytes.fromhex(parts[0])
                expected = bytes.fromhex(parts[1])
                dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
                return secrets.compare_digest(dk, expected)
            except Exception:
                return False
    return False

# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

def create_session(db, user_id: int) -> str:
    token = secrets.token_hex(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=SESSION_TTL_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
    db.execute(
        "INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)",
        (user_id, token, expires_at),
    )
    db.commit()
    return token


def get_session_user(db, token: str):
    """Return the user row for a valid, unexpired session, or None."""
    if not token or len(token) != 64:
        return None
    now = datetime.now(timezone.utc).isoformat()
    row = db.execute(
        "SELECT s.user_id, s.expires_at FROM sessions s WHERE s.token = ?",
        (token,),
    ).fetchone()
    if row is None:
        return None
    # Compare expiry — stored as "YYYY-MM-DD HH:MM:SS" UTC (SQLite format)
    expires_str = row["expires_at"]
    try:
        expires_at = datetime.strptime(expires_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
            db.commit()
            return None
    except Exception:
        return None
    user = db.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    return user


def extract_token(environ) -> str:
    auth = environ.get("HTTP_AUTHORIZATION", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return ""

# ---------------------------------------------------------------------------
# Rate limiting helpers
# ---------------------------------------------------------------------------

def _sqlite_utc_now() -> str:
    """Return current UTC time in SQLite's CURRENT_TIMESTAMP format (no timezone suffix)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def is_account_locked(db, email: str) -> bool:
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=LOCKOUT_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
    count = db.execute(
        "SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0 AND attempted_at >= ?",
        (email, cutoff),
    ).fetchone()[0]
    return count >= MAX_FAILED_ATTEMPTS


def record_login_attempt(db, email: str, success: bool):
    db.execute(
        "INSERT INTO login_attempts (email, success) VALUES (?, ?)",
        (email, 1 if success else 0),
    )
    db.commit()

# ---------------------------------------------------------------------------
# CSRF / Origin validation
# ---------------------------------------------------------------------------

def validate_origin(environ) -> bool:
    """
    For state-changing requests, we accept if Origin/Referer is absent (curl/server-to-server)
    or matches a known pattern. Since this is a CGI proxy environment we allow all origins but
    verify the header is not an obvious cross-site mismatch.
    In practice the CGI proxy layer already enforces CORS — this is a belt-and-suspenders check.
    """
    # Allow if no origin header (server-to-server, curl, mobile apps)
    origin = environ.get("HTTP_ORIGIN", "")
    if not origin:
        return True
    # Block null origin (sandboxed iframes with bad actors) — our own iframe is fine
    # because the proxy sets CORS headers. We accept everything except explicit
    # "null" which some CSRF attacks use.
    if origin == "null":
        return False
    return True

# ---------------------------------------------------------------------------
# Request / Response helpers
# ---------------------------------------------------------------------------

def read_body(environ) -> bytes:
    try:
        length = int(environ.get("CONTENT_LENGTH", 0) or 0)
    except (ValueError, TypeError):
        length = 0
    length = min(length, MAX_BODY_BYTES)
    if length <= 0:
        return b""
    return sys.stdin.buffer.read(length)


def parse_json_body(environ):
    raw = read_body(environ)
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def respond(status: int, body: dict):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print()
    print(json.dumps(body))
    sys.stdout.flush()


def user_dict(user) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
        "display_name": user["display_name"],
        "created_at": user["created_at"],
        "updated_at": user["updated_at"],
    }


def device_dict(row) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "name": row["name"],
        "room": row["room"],
        "type": row["type"],
        "is_on": bool(row["is_on"]),
        "brightness": row["brightness"],
        "speed": row["speed"],
        "temp": row["temp"],
        "mode": row["mode"],
        "power_draw": row["power_draw"],
        "locked": bool(row["locked"]),
        "favorite": bool(row["favorite"]),
        "color_temp": row["color_temp"],
        "created_at": row["created_at"],
    }

# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

def handle_register(db, environ, body):
    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    display_name = str(body.get("display_name", "")).strip()

    # Validate email
    if not email or not EMAIL_RE.match(email):
        return respond(400, {"error": "Invalid email address"})

    # Validate password length
    if len(password) < PASSWORD_MIN_LEN:
        return respond(400, {"error": f"Password must be at least {PASSWORD_MIN_LEN} characters"})

    # Validate display name
    if not display_name:
        return respond(400, {"error": "Display name is required"})
    if len(display_name) > 100:
        return respond(400, {"error": "Display name too long (max 100 chars)"})

    # Check duplicate email
    existing = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        return respond(409, {"error": "Email already registered"})

    # Hash and store
    pw_hash = hash_password(password)
    cursor = db.execute(
        "INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)",
        (email, pw_hash, display_name),
    )
    db.commit()
    user_id = cursor.lastrowid

    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    token = create_session(db, user_id)

    respond(201, {"token": token, "user": user_dict(user)})


def handle_login(db, environ, body):
    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))

    if not email or not EMAIL_RE.match(email):
        return respond(400, {"error": "Invalid email address"})

    if not password:
        return respond(400, {"error": "Password is required"})

    # Rate limit check
    if is_account_locked(db, email):
        return respond(429, {"error": "Account temporarily locked due to too many failed attempts. Try again later."})

    user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user is None:
        # Don't reveal whether email exists; record attempt anyway
        record_login_attempt(db, email, False)
        return respond(401, {"error": "Invalid email or password"})

    if not verify_password(password, user["password_hash"]):
        record_login_attempt(db, email, False)
        return respond(401, {"error": "Invalid email or password"})

    # Success — reset failed attempts by recording success
    record_login_attempt(db, email, True)

    # Invalidate old sessions for this user (optional — comment out to allow multi-device)
    # db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))

    token = create_session(db, user["id"])
    respond(200, {"token": token, "user": user_dict(user)})


def handle_logout(db, environ):
    token = extract_token(environ)
    if not token:
        return respond(401, {"error": "No token provided"})
    db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    db.commit()
    respond(200, {"message": "Logged out successfully"})


def handle_me(db, environ):
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})
    respond(200, {"user": user_dict(user)})


def handle_get_devices(db, environ):
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    rows = db.execute(
        "SELECT * FROM devices WHERE user_id = ? ORDER BY created_at ASC",
        (user["id"],),
    ).fetchall()
    respond(200, {"devices": [device_dict(r) for r in rows]})


def handle_create_device(db, environ, body):
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    name = str(body.get("name", "")).strip()
    room = str(body.get("room", "")).strip()
    device_type = str(body.get("type", "")).strip()

    if not name:
        return respond(400, {"error": "Device name is required"})
    if len(name) > 100:
        return respond(400, {"error": "Device name too long (max 100 chars)"})
    if not room:
        return respond(400, {"error": "Room is required"})
    if len(room) > 100:
        return respond(400, {"error": "Room too long (max 100 chars)"})
    if not device_type:
        return respond(400, {"error": "Device type is required"})

    # Optional fields with defaults
    is_on = 1 if body.get("is_on") else 0
    brightness = int(body.get("brightness", 100))
    speed = str(body.get("speed", "Off"))[:20]
    temp = int(body.get("temp", 72))
    mode = str(body.get("mode", "Auto"))[:20]
    power_draw = float(body.get("power_draw", 0))
    locked = 1 if body.get("locked", True) else 0
    favorite = 1 if body.get("favorite", False) else 0
    color_temp = int(body.get("color_temp", 50))

    cursor = db.execute(
        """INSERT INTO devices
           (user_id, name, room, type, is_on, brightness, speed, temp, mode,
            power_draw, locked, favorite, color_temp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user["id"], name, room, device_type, is_on, brightness, speed, temp,
         mode, power_draw, locked, favorite, color_temp),
    )
    db.commit()
    device = db.execute("SELECT * FROM devices WHERE id = ?", (cursor.lastrowid,)).fetchone()
    respond(201, {"device": device_dict(device)})


def handle_update_device(db, environ, body, device_id):
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    try:
        device_id = int(device_id)
    except (TypeError, ValueError):
        return respond(400, {"error": "Invalid device ID"})

    existing = db.execute(
        "SELECT * FROM devices WHERE id = ? AND user_id = ?",
        (device_id, user["id"]),
    ).fetchone()
    if existing is None:
        return respond(404, {"error": "Device not found"})

    # Build SET clause from allowed updatable fields only
    ALLOWED_FIELDS = {
        "name": str, "room": str, "type": str,
        "is_on": int, "brightness": int, "speed": str,
        "temp": int, "mode": str, "power_draw": float,
        "locked": int, "favorite": int, "color_temp": int,
    }
    updates = []
    params = []
    for field, cast in ALLOWED_FIELDS.items():
        if field in body:
            val = body[field]
            # Boolean-ish int fields
            if field in ("is_on", "locked", "favorite"):
                val = 1 if val else 0
            else:
                try:
                    val = cast(val)
                except (TypeError, ValueError):
                    return respond(400, {"error": f"Invalid value for field '{field}'"})
            # String length caps
            if cast is str and len(str(val)) > 200:
                return respond(400, {"error": f"Field '{field}' is too long"})
            updates.append(f"{field} = ?")
            params.append(val)

    if not updates:
        return respond(400, {"error": "No valid fields provided for update"})

    params.append(device_id)
    db.execute(
        f"UPDATE devices SET {', '.join(updates)} WHERE id = ?",
        params,
    )
    db.commit()

    device = db.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
    respond(200, {"device": device_dict(device)})


def handle_delete_device(db, environ, device_id):
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    try:
        device_id = int(device_id)
    except (TypeError, ValueError):
        return respond(400, {"error": "Invalid device ID"})

    existing = db.execute(
        "SELECT id FROM devices WHERE id = ? AND user_id = ?",
        (device_id, user["id"]),
    ).fetchone()
    if existing is None:
        return respond(404, {"error": "Device not found"})

    db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    db.commit()
    respond(200, {"message": "Device deleted"})

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def route(db, environ):
    method = environ.get("REQUEST_METHOD", "GET").upper()
    path = environ.get("PATH_INFO", "").rstrip("/")

    # CSRF check for state-changing methods
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        if not validate_origin(environ):
            return respond(403, {"error": "Forbidden: invalid origin"})

    # Parse body for methods that carry one
    body = None
    if method in ("POST", "PUT", "PATCH"):
        body = parse_json_body(environ)

    # --- Auth routes ---
    if path == "/auth/register" and method == "POST":
        return handle_register(db, environ, body)

    if path == "/auth/login" and method == "POST":
        return handle_login(db, environ, body)

    if path == "/auth/logout" and method == "POST":
        return handle_logout(db, environ)

    if path == "/auth/me" and method == "GET":
        return handle_me(db, environ)

    # --- Device routes ---
    if path == "/devices" and method == "GET":
        return handle_get_devices(db, environ)

    if path == "/devices" and method == "POST":
        return handle_create_device(db, environ, body)

    # /devices/<id>
    device_match = re.match(r"^/devices/(\d+)$", path)
    if device_match:
        dev_id = device_match.group(1)
        if method == "PUT":
            return handle_update_device(db, environ, body, dev_id)
        if method == "DELETE":
            return handle_delete_device(db, environ, dev_id)

    # 404 fallback
    respond(404, {"error": f"Not found: {method} {path}"})

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    environ = os.environ
    try:
        db = get_db()
        init_db(db)
        route(db, environ)
    except BrokenPipeError:
        pass
    except Exception as exc:
        # Generic 500 — never leak stack traces to client
        respond(500, {"error": "Internal server error"})
        # Write sanitized error to stderr (visible in server logs, not in response)
        print(f"UNHANDLED EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
