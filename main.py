from __future__ import annotations

import json
import uuid
from collections import deque
from pathlib import Path
from typing import Deque, Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Let's Connect")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
INDEX_FILE = STATIC_DIR / "index.html"

# In-memory state for MVP.
waiting_queue: Deque[str] = deque()
connections: Dict[str, WebSocket] = {}
partners: Dict[str, str] = {}


def websocket_by_id(client_id: str) -> Optional[WebSocket]:
    return connections.get(client_id)


async def send_to(client_id: str, payload: dict) -> None:
    ws = websocket_by_id(client_id)
    if ws:
        await ws.send_text(json.dumps(payload))


async def remove_from_queue(client_id: str) -> None:
    if client_id in waiting_queue:
        waiting_queue.remove(client_id)


async def find_match_for(client_id: str) -> Optional[str]:
    while waiting_queue:
        candidate = waiting_queue.popleft()
        if candidate == client_id:
            continue
        if candidate not in connections:
            continue
        if candidate in partners:
            continue
        return candidate
    return None


async def add_to_queue_or_match(client_id: str) -> None:
    if client_id not in connections:
        return

    # Remove stale queue entry if present.
    await remove_from_queue(client_id)

    match_id = await find_match_for(client_id)
    if not match_id:
        waiting_queue.append(client_id)
        await send_to(client_id, {"type": "status", "state": "waiting", "message": "Waiting for a stranger..."})
        return

    partners[client_id] = match_id
    partners[match_id] = client_id

    # The first user in this pair initiates the WebRTC offer.
    await send_to(client_id, {"type": "matched", "partnerId": match_id, "isInitiator": True})
    await send_to(match_id, {"type": "matched", "partnerId": client_id, "isInitiator": False})


async def disconnect_partner(client_id: str, notify: bool = True) -> None:
    partner_id = partners.pop(client_id, None)
    if not partner_id:
        return

    # Clear reverse map safely.
    if partners.get(partner_id) == client_id:
        partners.pop(partner_id, None)

    if notify and partner_id in connections:
        await send_to(partner_id, {"type": "partner_disconnected", "message": "Stranger disconnected."})

    # Re-queue remaining connected partner.
    if partner_id in connections:
        await add_to_queue_or_match(partner_id)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    client_id = str(uuid.uuid4())
    connections[client_id] = websocket

    await send_to(client_id, {"type": "connected", "clientId": client_id})
    await add_to_queue_or_match(client_id)

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "next":
                await disconnect_partner(client_id, notify=True)
                await add_to_queue_or_match(client_id)
                continue

            partner_id = partners.get(client_id)
            if not partner_id or partner_id not in connections:
                await send_to(client_id, {"type": "status", "state": "waiting", "message": "Waiting for a stranger..."})
                continue

            if msg_type in {"offer", "answer", "ice_candidate"}:
                await send_to(partner_id, {
                    "type": msg_type,
                    "from": client_id,
                    "payload": data.get("payload"),
                })
            elif msg_type in {"chat", "media"}:
                await send_to(partner_id, {
                    "type": msg_type,
                    "from": client_id,
                    "payload": data.get("payload"),
                })
            else:
                await send_to(client_id, {"type": "error", "message": f"Unsupported message type: {msg_type}"})

    except WebSocketDisconnect:
        pass
    finally:
        await remove_from_queue(client_id)
        await disconnect_partner(client_id, notify=True)
        connections.pop(client_id, None)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(INDEX_FILE)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
