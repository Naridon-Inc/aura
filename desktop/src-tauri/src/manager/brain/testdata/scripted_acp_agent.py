# A scripted ACP agent for exercising a chat kept at a place without a model.
#
# It speaks the protocol the way a real adapter does — streamed chunks, a
# permission request that waits for its answer, cancel mid-turn, load with
# history replay — so the relay and the client are tested for real while the
# words are fixed. Answers are picked by what the prompt asks for.
import json, os, sys, threading, time, uuid

lock = threading.Lock()
sessions = {}
cancelled = set()
waiting = {}
ids = [1000]


def send(m):
    with lock:
        sys.stdout.write(json.dumps(m) + "\n")
        sys.stdout.flush()


def update(sid, kind, **fields):
    u = {"sessionUpdate": kind}
    u.update(fields)
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": u}})


def chunk(sid, text, kind="agent_message_chunk"):
    update(sid, kind, content={"type": "text", "text": text})


def ask(sid, path):
    with lock:
        rid = ids[0]
        ids[0] += 1
    done = threading.Event()
    waiting[rid] = [done, None]
    options = [
        {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
        {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
        {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
    ]
    call = {"toolCallId": "write-1", "title": "Write " + path, "kind": "edit", "status": "pending"}
    send({"jsonrpc": "2.0", "id": rid, "method": "session/request_permission",
          "params": {"sessionId": sid, "toolCall": call, "options": options}})
    done.wait(300)
    return waiting.pop(rid)[1] or {}


def prompt(mid, sid, text):
    s = sessions[sid]
    s["history"].append(("user", text))
    t = text.lower()
    words, delay = ["I did not understand."], 0.0
    if "word pong" in t:
        words = ["po", "ng"]
    elif "1 to 150" in t:
        words, delay = ["%d\n" % i for i in range(1, 151)], 0.05
    elif "essay" in t:
        words, delay = ["river "] * 4000, 0.05
    elif "word viewers" in t:
        words = ["view", "ers"]
    elif "file named" in t:
        path = os.path.join(s["cwd"], "aura-permission-check.txt")
        answer = ask(sid, path).get("outcome", {})
        if answer.get("outcome") == "selected" and answer.get("optionId") in ("allow", "always"):
            with open(path, "w") as f:
                f.write("ok\n")
            words = ["Wrote it."]
        else:
            words = ["You said no, so nothing was written."]
    elif "first answer" in t:
        words = [next(x for r, x in s["history"] if r == "assistant")]
    said = ""
    for w in words:
        if sid in cancelled:
            cancelled.discard(sid)
            s["history"].append(("assistant", said))
            send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "cancelled"}})
            return
        chunk(sid, w)
        said += w
        if delay:
            time.sleep(delay)
    s["history"].append(("assistant", said))
    send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})


MODES = {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}]}

for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    method, mid, p = m.get("method"), m.get("id"), m.get("params") or {}
    if method is None:
        if mid in waiting:
            waiting[mid][1] = m.get("result")
            waiting[mid][0].set()
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": 1, "authMethods": [],
            "agentCapabilities": {"loadSession": True, "promptCapabilities": {}},
            "agentInfo": {"name": "scripted", "version": "1"}}})
    elif method == "session/new":
        sid = "s-" + uuid.uuid4().hex
        sessions[sid] = {"cwd": p.get("cwd", "."), "history": []}
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": sid, "modes": MODES}})
    elif method == "session/load":
        s = sessions.get(p.get("sessionId"))
        if s is None:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32002, "message": "no such session"}})
            continue
        for role, text in s["history"]:
            chunk(p["sessionId"], text, "user_message_chunk" if role == "user" else "agent_message_chunk")
        send({"jsonrpc": "2.0", "id": mid, "result": {"modes": MODES}})
    elif method == "session/prompt":
        text = "".join(b.get("text", "") for b in p.get("prompt", []))
        threading.Thread(target=prompt, args=(mid, p["sessionId"], text), daemon=True).start()
    elif method == "session/cancel":
        cancelled.add(p.get("sessionId"))
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
