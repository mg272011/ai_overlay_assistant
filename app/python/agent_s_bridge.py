#!/usr/bin/env python3
import sys
import json
import os
import io
import time
import platform
from typing import Any, Dict

# Prefer local vendored gui_agents from app/python
LOCAL_PYTHON_DIR = os.path.dirname(__file__)
if LOCAL_PYTHON_DIR not in sys.path:
    sys.path.insert(0, LOCAL_PYTHON_DIR)
# Optional fallback to external Agent-S repo (kept for dev only, lower priority)
AGENT_S_REPO = os.environ.get("AGENT_S_REPO")
if AGENT_S_REPO and AGENT_S_REPO not in sys.path:
    sys.path.append(AGENT_S_REPO)

import pyautogui
from PIL import Image

from gui_agents.s2_5.agents.agent_s import AgentS2_5
from gui_agents.s2_5.agents.grounding import OSWorldACI

current_platform = platform.system().lower()

agent = None
scaled_width = None
scaled_height = None


def scale_screen_dimensions(width: int, height: int, max_dim_size: int):
    scale_factor = min(max_dim_size / width, max_dim_size / height, 1)
    safe_width = int(width * scale_factor)
    safe_height = int(height * scale_factor)
    return safe_width, safe_height


def send(obj: Dict[str, Any]):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def handle_init(msg: Dict[str, Any]):
    global agent, scaled_width, scaled_height

    provider = msg.get("provider", "openai")
    # Default to env override or gpt-4o if not specified
    model = msg.get("model", os.environ.get("AGENT_S_MODEL", "gpt-4o"))
    model_url = msg.get("model_url", "")
    model_api_key = msg.get("model_api_key", "")

    ground_provider = msg["ground_provider"]
    ground_url = msg["ground_url"]
    ground_model = msg["ground_model"]
    ground_api_key = msg.get("ground_api_key", "")
    grounding_width = int(msg["grounding_width"])  # required
    grounding_height = int(msg["grounding_height"])  # required

    screen_w, screen_h = pyautogui.size()
    scaled_width, scaled_height = scale_screen_dimensions(screen_w, screen_h, max_dim_size=2400)

    engine_params = {
        "engine_type": provider,
        "model": model,
        "base_url": model_url,
        "api_key": model_api_key,
    }

    engine_params_for_grounding = {
        "engine_type": ground_provider,
        "model": ground_model,
        "base_url": ground_url,
        "api_key": ground_api_key,
        "grounding_width": grounding_width,
        "grounding_height": grounding_height,
    }

    grounding_agent = OSWorldACI(
        platform=current_platform,
        engine_params_for_generation=engine_params,
        engine_params_for_grounding=engine_params_for_grounding,
        width=screen_w,
        height=screen_h,
    )

    agent = AgentS2_5(
        engine_params,
        grounding_agent,
        platform=current_platform,
        max_trajectory_length=msg.get("max_trajectory_length", 8),
        enable_reflection=bool(msg.get("enable_reflection", True)),
    )

    send({"type": "inited", "screen": {"width": screen_w, "height": screen_h}, "scaled": {"width": scaled_width, "height": scaled_height}})


def handle_run(msg: Dict[str, Any]):
    instruction = msg.get("query", "")
    if not instruction:
        send({"type": "error", "message": "Missing query"})
        return

    # Reset per run
    agent.reset()
    obs: Dict[str, Any] = {}

    for step in range(30):  # max 30 steps
        try:
            screenshot = pyautogui.screenshot()
            screenshot = screenshot.resize((scaled_width, scaled_height), Image.LANCZOS)
            buf = io.BytesIO()
            screenshot.save(buf, format="PNG")
            obs["screenshot"] = buf.getvalue()
            send({"type": "screenshot", "step": step, "scaled": {"width": scaled_width, "height": scaled_height}})
        except Exception as e:
            send({"type": "error", "message": f"screenshot_failed: {str(e)}", "step": step})
            time.sleep(0.5)
            continue

        # Predict next action
        try:
            send({"type": "predicting", "step": step})
            info, code_list = agent.predict(instruction=instruction, observation=obs)
            code = code_list[0] if code_list else ""
        except Exception as e:
            send({"type": "predict_error", "error": str(e), "step": step})
            time.sleep(0.5)
            continue

        # Terminal cases
        low = code.lower()
        if "done" in low:
            send({"type": "done", "info": info})
            return
        if "fail" in low:
            send({"type": "fail", "info": info})
            return
        if "wait" in low:
            send({"type": "wait", "seconds": 1.0})
            time.sleep(1.0)
            continue
        if "next" in low:
            send({"type": "next"})
            continue

        # Execute action code (pyautogui)
        try:
            send({"type": "action", "code": code, "info": info, "step": step})
            time.sleep(0.3)
            exec(code, {"pyautogui": pyautogui, "time": time})
            time.sleep(0.7)
        except Exception as e:
            send({"type": "exec_error", "error": str(e), "code": code, "step": step})
            # small backoff
            time.sleep(0.5)

    send({"type": "timeout", "steps": 30})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            send({"type": "error", "message": "Invalid JSON"})
            continue

        t = msg.get("type")
        if t == "init":
            try:
                handle_init(msg)
            except Exception as e:
                send({"type": "error", "message": str(e)})
        elif t == "run":
            if agent is None:
                send({"type": "error", "message": "Not initialized"})
            else:
                handle_run(msg)
        elif t == "stop":
            send({"type": "stopped"})
            break
        else:
            send({"type": "error", "message": f"Unknown type: {t}"})


if __name__ == "__main__":
    main() 