/** Run with `python3 -c <script> <run-*.wandb>`. Prints one JSON object per line. */
export const READ_WANDB_SCRIPT = String.raw`
import json, os, sys, time

def emit(obj):
    print(json.dumps(obj), flush=True)

def fail(message):
    emit({"kind": "fatal", "message": message})
    raise SystemExit(0)

path = sys.argv[1]
try:
    import wandb
    wandb._assert_is_internal_process = True
    from wandb.sdk.internal.datastore import DataStore
    from wandb.proto.wandb_internal_pb2 import Record
except Exception:
    fail("wandb is not available")

def open_store():
    store = DataStore()
    store.open_for_scan(path)
    return store

def finite(value):
    return isinstance(value, (int, float)) and value == value and abs(value) != float("inf")

def history_points(record):
    step = None
    points = []
    for item in record.history.item:
        nested = list(getattr(item, "nested_key", []) or [])
        key = getattr(item, "key", "") or "/".join(nested)
        raw = getattr(item, "value_json", "")
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        try:
            value = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            continue
        if key == "_step" and finite(value):
            step = value
        elif key and not str(key).startswith("_") and finite(value):
            points.append({"step": value if step is None else None, "metric": str(key), "value": float(value)})
    if step is None:
        return None
    for point in points:
        point["step"] = step
    return points

try:
    ds = open_store()
except Exception:
    fail("cannot read this run")

offset = ds.get_offset()
while True:
    try:
        size = os.path.getsize(path)
    except OSError:
        fail("cannot read this run")
    if size < offset:
        emit({"kind": "reset"})
        try:
            ds.close()
            ds = open_store()
            offset = ds.get_offset()
        except Exception:
            fail("cannot read this run")
        continue
    try:
        data = ds.scan_data()
    except Exception:
        try:
            ds.seek(offset)
        except Exception:
            fail("cannot read this run")
        time.sleep(0.2)
        continue
    if data is None:
        time.sleep(0.2)
        continue
    offset = ds.get_offset()
    record = Record()
    try:
        record.ParseFromString(data)
    except Exception:
        emit({"kind": "skip", "error": "record did not parse"})
        continue
    kind = record.WhichOneof("record_type")
    if kind == "exit":
        emit({"kind": "exit"})
        break
    if kind != "history":
        continue
    try:
        points = history_points(record)
    except Exception:
        emit({"kind": "skip", "error": "history did not parse"})
        continue
    if points is None:
        emit({"kind": "skip", "error": "history has no _step"})
        continue
    for point in points:
        emit({"kind": "point", "step": point["step"], "metric": point["metric"], "value": point["value"]})
`
