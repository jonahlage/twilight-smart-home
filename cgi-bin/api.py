#!/usr/bin/env python3
"""
TwiLight Smart Home — Backend API
CGI-bin script with SQLite, session auth, device management,
and smart device integrations (Govee, LIFX).
"""

import json
import os
import re
import secrets
import sqlite3
import sys
import hashlib
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

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

# Encryption helpers for API keys (XOR with server-side secret)
# In production use a proper KMS — this provides obfuscation at rest
_SERVER_KEY = os.environ.get("TWILIGHT_SECRET", "tw1l1ght_sm4rt_h0me_s3rv3r_k3y_2026!")

def _xor_encrypt(plaintext: str) -> str:
    """Simple XOR-based obfuscation for API keys stored in SQLite."""
    key_bytes = _SERVER_KEY.encode("utf-8")
    data = plaintext.encode("utf-8")
    encrypted = bytes(d ^ key_bytes[i % len(key_bytes)] for i, d in enumerate(data))
    return encrypted.hex()

def _xor_decrypt(hex_str: str) -> str:
    """Reverse the XOR obfuscation."""
    key_bytes = _SERVER_KEY.encode("utf-8")
    data = bytes.fromhex(hex_str)
    decrypted = bytes(d ^ key_bytes[i % len(key_bytes)] for i, d in enumerate(data))
    return decrypted.decode("utf-8")

# ---------------------------------------------------------------------------
# Smart Home API Config
# ---------------------------------------------------------------------------
GOVEE_API_BASE = "https://openapi.api.govee.com/router/api/v1"
LIFX_API_BASE = "https://api.lifx.com/v1"

SUPPORTED_PROVIDERS = {
    "govee": {
        "name": "Govee",
        "description": "Smart LED lights, strips, and home devices",
        "key_label": "Govee API Key",
        "key_hint": "Find at https://developer.govee.com — free tier available",
    },
    "lifx": {
        "name": "LIFX",
        "description": "Smart WiFi light bulbs and strips",
        "key_label": "LIFX Personal Access Token",
        "key_hint": "Generate at https://cloud.lifx.com/settings",
    },
}

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

        CREATE TABLE IF NOT EXISTS smart_integrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            api_key_encrypted TEXT NOT NULL,
            connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_sync TIMESTAMP,
            UNIQUE(user_id, provider),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS smart_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            integration_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            model TEXT DEFAULT '',
            name TEXT NOT NULL,
            type TEXT DEFAULT 'light',
            is_online INTEGER DEFAULT 1,
            is_on INTEGER DEFAULT 0,
            brightness INTEGER DEFAULT 100,
            color_temp INTEGER DEFAULT 50,
            raw_capabilities TEXT DEFAULT '{}',
            last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, provider, external_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (integration_id) REFERENCES smart_integrations(id) ON DELETE CASCADE
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
        if stored_hash.startswith("$2"):
            try:
                return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
            except Exception:
                return False
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
    row = db.execute(
        "SELECT s.user_id, s.expires_at FROM sessions s WHERE s.token = ?",
        (token,),
    ).fetchone()
    if row is None:
        return None
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
    origin = environ.get("HTTP_ORIGIN", "")
    if not origin:
        return True
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


def smart_device_dict(row) -> dict:
    return {
        "id": row["id"],
        "provider": row["provider"],
        "external_id": row["external_id"],
        "model": row["model"],
        "name": row["name"],
        "type": row["type"],
        "is_online": bool(row["is_online"]),
        "is_on": bool(row["is_on"]),
        "brightness": row["brightness"],
        "color_temp": row["color_temp"],
        "raw_capabilities": json.loads(row["raw_capabilities"]) if row["raw_capabilities"] else {},
        "last_synced": row["last_synced"],
    }

# ---------------------------------------------------------------------------
# External API helpers
# ---------------------------------------------------------------------------

def _api_call(url, method="GET", headers=None, data=None, timeout=15):
    """Make an HTTP request and return (status_code, response_dict)."""
    hdrs = headers or {}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")

    req = Request(url, data=body, headers=hdrs, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            resp_body = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(resp_body)
            except json.JSONDecodeError:
                return resp.status, {"raw": resp_body}
    except HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8")
        except Exception:
            pass
        try:
            return e.code, json.loads(body_text)
        except Exception:
            return e.code, {"error": body_text or str(e)}
    except URLError as e:
        return 0, {"error": f"Connection error: {e.reason}"}
    except Exception as e:
        return 0, {"error": str(e)}

# ---------------------------------------------------------------------------
# Govee API helpers
# ---------------------------------------------------------------------------

def govee_list_devices(api_key: str):
    """Fetch all devices from Govee API."""
    url = f"{GOVEE_API_BASE}/user/devices"
    headers = {"Govee-API-Key": api_key, "Content-Type": "application/json"}
    status, data = _api_call(url, "GET", headers)
    return status, data


def govee_control_device(api_key: str, device_id: str, model: str, capability: dict):
    """Send a control command to a Govee device."""
    url = f"{GOVEE_API_BASE}/device/control"
    headers = {"Govee-API-Key": api_key, "Content-Type": "application/json"}
    payload = {
        "requestId": secrets.token_hex(8),
        "payload": {
            "sku": model,
            "device": device_id,
            "capability": capability,
        }
    }
    status, data = _api_call(url, "POST", headers, payload)
    return status, data


def govee_get_device_state(api_key: str, device_id: str, model: str):
    """Query current state of a Govee device."""
    url = f"{GOVEE_API_BASE}/device/state"
    headers = {"Govee-API-Key": api_key, "Content-Type": "application/json"}
    payload = {
        "requestId": secrets.token_hex(8),
        "payload": {
            "sku": model,
            "device": device_id,
        }
    }
    status, data = _api_call(url, "POST", headers, payload)
    return status, data

# ---------------------------------------------------------------------------
# LIFX API helpers
# ---------------------------------------------------------------------------

def lifx_list_lights(token: str):
    """Fetch all lights from LIFX API."""
    url = f"{LIFX_API_BASE}/lights/all"
    headers = {"Authorization": f"Bearer {token}"}
    status, data = _api_call(url, "GET", headers)
    return status, data


def lifx_set_state(token: str, selector: str, state: dict):
    """Set state on a LIFX light."""
    url = f"{LIFX_API_BASE}/lights/{selector}/state"
    headers = {"Authorization": f"Bearer {token}"}
    status, data = _api_call(url, "PUT", headers, state)
    return status, data


def lifx_toggle(token: str, selector: str):
    """Toggle a LIFX light."""
    url = f"{LIFX_API_BASE}/lights/{selector}/toggle"
    headers = {"Authorization": f"Bearer {token}"}
    status, data = _api_call(url, "POST", headers, {})
    return status, data

# ---------------------------------------------------------------------------
# Route handlers — Auth
# ---------------------------------------------------------------------------

def handle_register(db, environ, body):
    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    display_name = str(body.get("display_name", "")).strip()

    if not email or not EMAIL_RE.match(email):
        return respond(400, {"error": "Invalid email address"})
    if len(password) < PASSWORD_MIN_LEN:
        return respond(400, {"error": f"Password must be at least {PASSWORD_MIN_LEN} characters"})
    if not display_name:
        return respond(400, {"error": "Display name is required"})
    if len(display_name) > 100:
        return respond(400, {"error": "Display name too long (max 100 chars)"})

    existing = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        return respond(409, {"error": "Email already registered"})

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

    if is_account_locked(db, email):
        return respond(429, {"error": "Account temporarily locked due to too many failed attempts. Try again later."})

    user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user is None:
        record_login_attempt(db, email, False)
        return respond(401, {"error": "Invalid email or password"})

    if not verify_password(password, user["password_hash"]):
        record_login_attempt(db, email, False)
        return respond(401, {"error": "Invalid email or password"})

    record_login_attempt(db, email, True)
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

# ---------------------------------------------------------------------------
# Route handlers — Local Devices
# ---------------------------------------------------------------------------

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
            if field in ("is_on", "locked", "favorite"):
                val = 1 if val else 0
            else:
                try:
                    val = cast(val)
                except (TypeError, ValueError):
                    return respond(400, {"error": f"Invalid value for field '{field}'"})
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
# Route handlers — Smart Integrations
# ---------------------------------------------------------------------------

def handle_get_providers(db, environ):
    """Return list of supported smart device providers and user's connection status."""
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    integrations = db.execute(
        "SELECT provider, connected_at, last_sync FROM smart_integrations WHERE user_id = ?",
        (user["id"],),
    ).fetchall()
    connected = {row["provider"]: {"connected_at": row["connected_at"], "last_sync": row["last_sync"]} for row in integrations}

    providers = []
    for key, info in SUPPORTED_PROVIDERS.items():
        p = {**info, "id": key, "connected": key in connected}
        if key in connected:
            p["connected_at"] = connected[key]["connected_at"]
            p["last_sync"] = connected[key]["last_sync"]
        providers.append(p)

    respond(200, {"providers": providers})


def handle_connect_provider(db, environ, body):
    """Store an API key for a smart device provider (encrypted at rest)."""
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    provider = str(body.get("provider", "")).strip().lower()
    api_key = str(body.get("api_key", "")).strip()

    if provider not in SUPPORTED_PROVIDERS:
        return respond(400, {"error": f"Unsupported provider: {provider}"})
    if not api_key or len(api_key) < 10:
        return respond(400, {"error": "Invalid API key"})
    if len(api_key) > 500:
        return respond(400, {"error": "API key too long"})

    # Validate the key by attempting to list devices
    if provider == "govee":
        status, data = govee_list_devices(api_key)
        if status != 200:
            err_msg = "Invalid Govee API key or connection failed"
            if isinstance(data, dict) and data.get("msg"):
                err_msg = f"Govee: {data['msg']}"
            return respond(400, {"error": err_msg})
    elif provider == "lifx":
        status, data = lifx_list_lights(api_key)
        if status != 200:
            return respond(400, {"error": "Invalid LIFX token or connection failed"})

    # Encrypt and store
    encrypted_key = _xor_encrypt(api_key)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    existing = db.execute(
        "SELECT id FROM smart_integrations WHERE user_id = ? AND provider = ?",
        (user["id"], provider),
    ).fetchone()

    if existing:
        db.execute(
            "UPDATE smart_integrations SET api_key_encrypted = ?, connected_at = ?, last_sync = ? WHERE id = ?",
            (encrypted_key, now, now, existing["id"]),
        )
        integration_id = existing["id"]
    else:
        cursor = db.execute(
            "INSERT INTO smart_integrations (user_id, provider, api_key_encrypted, connected_at, last_sync) VALUES (?, ?, ?, ?, ?)",
            (user["id"], provider, encrypted_key, now, now),
        )
        integration_id = cursor.lastrowid
    db.commit()

    # Sync devices from this provider
    device_count = _sync_provider_devices(db, user["id"], integration_id, provider, api_key)

    respond(200, {
        "message": f"Connected to {SUPPORTED_PROVIDERS[provider]['name']} successfully",
        "provider": provider,
        "devices_found": device_count,
    })


def handle_disconnect_provider(db, environ, body):
    """Remove a smart device provider connection."""
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    provider = str(body.get("provider", "")).strip().lower()
    if provider not in SUPPORTED_PROVIDERS:
        return respond(400, {"error": f"Unsupported provider: {provider}"})

    # Delete devices and integration
    db.execute(
        "DELETE FROM smart_devices WHERE user_id = ? AND provider = ?",
        (user["id"], provider),
    )
    db.execute(
        "DELETE FROM smart_integrations WHERE user_id = ? AND provider = ?",
        (user["id"], provider),
    )
    db.commit()
    respond(200, {"message": f"Disconnected from {SUPPORTED_PROVIDERS[provider]['name']}"})


def _sync_provider_devices(db, user_id, integration_id, provider, api_key):
    """Sync devices from a provider API into local DB. Returns count."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    if provider == "govee":
        status, data = govee_list_devices(api_key)
        if status != 200:
            return 0
        devices = []
        # Govee v2 returns: { "code": 200, "message": "...", "data": [...] }
        raw_devices = data.get("data", [])
        if not isinstance(raw_devices, list):
            raw_devices = []
        for dev in raw_devices:
            device_id = dev.get("device", "")
            sku = dev.get("sku", "")
            name = dev.get("deviceName", sku)
            capabilities = dev.get("capabilities", [])
            # Determine type from capabilities
            dev_type = "light"  # default
            cap_types = [c.get("type", "") for c in capabilities] if isinstance(capabilities, list) else []
            if any("color" in ct.lower() or "brightness" in ct.lower() for ct in cap_types):
                dev_type = "light"

            devices.append({
                "external_id": device_id,
                "model": sku,
                "name": name or f"Govee {sku}",
                "type": dev_type,
                "raw_capabilities": json.dumps(capabilities),
            })

        for d in devices:
            existing = db.execute(
                "SELECT id FROM smart_devices WHERE user_id = ? AND provider = ? AND external_id = ?",
                (user_id, provider, d["external_id"]),
            ).fetchone()
            if existing:
                db.execute(
                    """UPDATE smart_devices SET name = ?, model = ?, type = ?,
                       raw_capabilities = ?, last_synced = ? WHERE id = ?""",
                    (d["name"], d["model"], d["type"], d["raw_capabilities"], now, existing["id"]),
                )
            else:
                db.execute(
                    """INSERT INTO smart_devices
                       (user_id, integration_id, provider, external_id, model, name, type, raw_capabilities, last_synced)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (user_id, integration_id, provider, d["external_id"], d["model"],
                     d["name"], d["type"], d["raw_capabilities"], now),
                )
        db.commit()
        return len(devices)

    elif provider == "lifx":
        status, data = lifx_list_lights(api_key)
        if status != 200:
            return 0
        if not isinstance(data, list):
            return 0

        devices = []
        for light in data:
            light_id = light.get("id", "")
            label = light.get("label", "LIFX Light")
            product = light.get("product", {})
            product_name = product.get("name", "LIFX") if isinstance(product, dict) else "LIFX"
            connected = light.get("connected", False)
            power = light.get("power", "off")
            brightness_val = light.get("brightness", 1.0)
            color = light.get("color", {})
            kelvin = color.get("kelvin", 3500) if isinstance(color, dict) else 3500

            devices.append({
                "external_id": light_id,
                "model": product_name,
                "name": label,
                "type": "light",
                "is_online": 1 if connected else 0,
                "is_on": 1 if power == "on" else 0,
                "brightness": int(brightness_val * 100),
                "color_temp": int((kelvin - 1500) / 90) if kelvin else 50,
                "raw_capabilities": json.dumps({"product": product, "group": light.get("group", {})}),
            })

        for d in devices:
            existing = db.execute(
                "SELECT id FROM smart_devices WHERE user_id = ? AND provider = ? AND external_id = ?",
                (user_id, provider, d["external_id"]),
            ).fetchone()
            if existing:
                db.execute(
                    """UPDATE smart_devices SET name = ?, model = ?, type = ?, is_online = ?,
                       is_on = ?, brightness = ?, color_temp = ?, raw_capabilities = ?, last_synced = ?
                       WHERE id = ?""",
                    (d["name"], d["model"], d["type"], d["is_online"], d["is_on"],
                     d["brightness"], d["color_temp"], d["raw_capabilities"], now, existing["id"]),
                )
            else:
                db.execute(
                    """INSERT INTO smart_devices
                       (user_id, integration_id, provider, external_id, model, name, type, is_online,
                        is_on, brightness, color_temp, raw_capabilities, last_synced)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (user_id, integration_id, provider, d["external_id"], d["model"],
                     d["name"], d["type"], d["is_online"], d["is_on"],
                     d["brightness"], d["color_temp"], d["raw_capabilities"], now),
                )
        db.commit()
        return len(devices)

    return 0

# ---------------------------------------------------------------------------
# Route handlers — Smart Devices
# ---------------------------------------------------------------------------

def handle_get_smart_devices(db, environ):
    """Get all smart devices for the logged-in user."""
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    rows = db.execute(
        "SELECT * FROM smart_devices WHERE user_id = ? ORDER BY provider, name",
        (user["id"],),
    ).fetchall()
    respond(200, {"devices": [smart_device_dict(r) for r in rows]})


def handle_sync_smart_devices(db, environ, body):
    """Re-sync devices from a specific provider."""
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    provider = str(body.get("provider", "")).strip().lower()
    if provider and provider not in SUPPORTED_PROVIDERS:
        return respond(400, {"error": f"Unsupported provider: {provider}"})

    # Get integrations to sync
    if provider:
        integrations = db.execute(
            "SELECT * FROM smart_integrations WHERE user_id = ? AND provider = ?",
            (user["id"], provider),
        ).fetchall()
    else:
        integrations = db.execute(
            "SELECT * FROM smart_integrations WHERE user_id = ?",
            (user["id"],),
        ).fetchall()

    if not integrations:
        return respond(404, {"error": "No integrations found to sync"})

    total_devices = 0
    for integ in integrations:
        api_key = _xor_decrypt(integ["api_key_encrypted"])
        count = _sync_provider_devices(db, user["id"], integ["id"], integ["provider"], api_key)
        total_devices += count
        # Update last_sync
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        db.execute("UPDATE smart_integrations SET last_sync = ? WHERE id = ?", (now, integ["id"]))
    db.commit()

    rows = db.execute(
        "SELECT * FROM smart_devices WHERE user_id = ? ORDER BY provider, name",
        (user["id"],),
    ).fetchall()
    respond(200, {"message": f"Synced {total_devices} devices", "devices": [smart_device_dict(r) for r in rows]})


def handle_smart_device_control(db, environ, body):
    """Control a smart device (turn on/off, set brightness, etc.)."""
    token = extract_token(environ)
    user = get_session_user(db, token)
    if user is None:
        return respond(401, {"error": "Invalid or expired session"})

    if body is None:
        return respond(400, {"error": "Invalid JSON body"})

    smart_device_id = body.get("device_id")
    action = str(body.get("action", "")).strip()

    if not smart_device_id or not action:
        return respond(400, {"error": "device_id and action are required"})

    # Find the device
    device = db.execute(
        "SELECT sd.*, si.api_key_encrypted FROM smart_devices sd JOIN smart_integrations si ON sd.integration_id = si.id WHERE sd.id = ? AND sd.user_id = ?",
        (smart_device_id, user["id"]),
    ).fetchone()

    if device is None:
        return respond(404, {"error": "Smart device not found"})

    api_key = _xor_decrypt(device["api_key_encrypted"])
    provider = device["provider"]
    external_id = device["external_id"]
    model = device["model"]

    status_code = 200
    api_result = {}

    if provider == "govee":
        if action == "turn_on":
            cap = {"type": "devices.capabilities.on_off", "instance": "powerSwitch", "value": 1}
            status_code, api_result = govee_control_device(api_key, external_id, model, cap)
            if status_code == 200:
                db.execute("UPDATE smart_devices SET is_on = 1 WHERE id = ?", (smart_device_id,))
        elif action == "turn_off":
            cap = {"type": "devices.capabilities.on_off", "instance": "powerSwitch", "value": 0}
            status_code, api_result = govee_control_device(api_key, external_id, model, cap)
            if status_code == 200:
                db.execute("UPDATE smart_devices SET is_on = 0 WHERE id = ?", (smart_device_id,))
        elif action == "set_brightness":
            brightness = int(body.get("value", 100))
            brightness = max(0, min(100, brightness))
            cap = {"type": "devices.capabilities.range", "instance": "brightness", "value": brightness}
            status_code, api_result = govee_control_device(api_key, external_id, model, cap)
            if status_code == 200:
                db.execute("UPDATE smart_devices SET brightness = ? WHERE id = ?", (brightness, smart_device_id))
        elif action == "set_color_temp":
            temp_val = int(body.get("value", 4000))
            cap = {"type": "devices.capabilities.color_setting", "instance": "colorTemperatureK", "value": temp_val}
            status_code, api_result = govee_control_device(api_key, external_id, model, cap)
        else:
            return respond(400, {"error": f"Unsupported action: {action}"})

    elif provider == "lifx":
        selector = f"id:{external_id}"
        if action == "turn_on":
            status_code, api_result = lifx_set_state(api_key, selector, {"power": "on"})
            if status_code == 207 or status_code == 200:
                db.execute("UPDATE smart_devices SET is_on = 1 WHERE id = ?", (smart_device_id,))
                status_code = 200
        elif action == "turn_off":
            status_code, api_result = lifx_set_state(api_key, selector, {"power": "off"})
            if status_code == 207 or status_code == 200:
                db.execute("UPDATE smart_devices SET is_on = 0 WHERE id = ?", (smart_device_id,))
                status_code = 200
        elif action == "set_brightness":
            brightness = int(body.get("value", 100))
            brightness = max(0, min(100, brightness))
            status_code, api_result = lifx_set_state(api_key, selector, {"brightness": brightness / 100.0})
            if status_code == 207 or status_code == 200:
                db.execute("UPDATE smart_devices SET brightness = ? WHERE id = ?", (brightness, smart_device_id))
                status_code = 200
        elif action == "set_color_temp":
            kelvin = int(body.get("value", 3500))
            status_code, api_result = lifx_set_state(api_key, selector, {"color": f"kelvin:{kelvin}"})
        elif action == "toggle":
            status_code, api_result = lifx_toggle(api_key, selector)
            if status_code == 207 or status_code == 200:
                # Toggle local state
                current = device["is_on"]
                db.execute("UPDATE smart_devices SET is_on = ? WHERE id = ?", (0 if current else 1, smart_device_id))
                status_code = 200
        else:
            return respond(400, {"error": f"Unsupported action: {action}"})

    db.commit()

    # Return updated device
    updated = db.execute("SELECT * FROM smart_devices WHERE id = ?", (smart_device_id,)).fetchone()
    api_status = "success" if status_code == 200 else "error"
    respond(200 if status_code == 200 else 422, {
        "status": api_status,
        "device": smart_device_dict(updated) if updated else None,
        "api_response": api_result,
    })

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

    # --- Local Device routes ---
    if path == "/devices" and method == "GET":
        return handle_get_devices(db, environ)

    if path == "/devices" and method == "POST":
        return handle_create_device(db, environ, body)

    device_match = re.match(r"^/devices/(\d+)$", path)
    if device_match:
        dev_id = device_match.group(1)
        if method == "PUT":
            return handle_update_device(db, environ, body, dev_id)
        if method == "DELETE":
            return handle_delete_device(db, environ, dev_id)

    # --- Smart Integration routes ---
    if path == "/smart/providers" and method == "GET":
        return handle_get_providers(db, environ)

    if path == "/smart/connect" and method == "POST":
        return handle_connect_provider(db, environ, body)

    if path == "/smart/disconnect" and method == "POST":
        return handle_disconnect_provider(db, environ, body)

    if path == "/smart/devices" and method == "GET":
        return handle_get_smart_devices(db, environ)

    if path == "/smart/sync" and method == "POST":
        return handle_sync_smart_devices(db, environ, body)

    if path == "/smart/control" and method == "POST":
        return handle_smart_device_control(db, environ, body)

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
        respond(500, {"error": "Internal server error"})
        print(f"UNHANDLED EXCEPTION: {type(exc).__name__}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
